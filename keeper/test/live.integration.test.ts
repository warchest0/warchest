import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAbi } from "viem";
import { RpcChainReader } from "../src/chain/reader.js";
import { RpcChainWriter } from "../src/chain/writer.js";
import { QUOTER_V2 } from "../src/config.js";
import { TradingEngine } from "../src/hyperliquid/engine.js";
import { Keeper } from "../src/keeper.js";
import { LiveExecutor } from "../src/live.js";
import { Store } from "../src/store.js";
import { anvilReady, KEEPER_KEY, startAnvilSystem, type AnvilSystem } from "./anvilSystem.js";
import { baseConfig, FakeAcross, FakeHl, HL_ACCOUNT, memoryAlerts, silentLogger, USD } from "./fakes.js";
import { SimExchange } from "./simExchange.js";

/**
 * End-to-end on anvil with the REAL vault + governance + MockAcrossSpokePool (DECISIONS.md D6) and a simulated
 * Hyperliquid: executeDecision → bridge fill → funding → entry → protection → equity report → guardian pause ⇒
 * mustClose ⇒ unwind → return plan for the multisig → USDG back → reportClosed → challenge window → finalizeClose
 * (PnL measured on-chain) → idle → late return reconciled. Every vault transaction is signed by the keeper key.
 */
describe.skipIf(!anvilReady())("live executor ↔ real vault (anvil)", () => {
  let sys: AnvilSystem;
  let reader: RpcChainReader;
  let writer: RpcChainWriter;
  beforeAll(async () => {
    sys = await startAnvilSystem();
    reader = new RpcChainReader(sys.rpc, sys.vault, sys.governance, QUOTER_V2);
    writer = new RpcChainWriter(sys.rpc, BigInt(sys.chainId), sys.vault, KEEPER_KEY, silentLogger());
  }, 60_000);
  afterAll(() => sys?.stop());

  it("refuses to broadcast a transaction the vault would revert (simulation first)", async () => {
    await expect(writer.reportClosed(1n)).rejects.toThrow(/NoSuchPosition|revert/i);
    await expect(writer.reconcile()).rejects.toThrow(/NothingToReconcile|revert/i);
  });

  it("runs a whole decision through the real vault", async () => {
    await sys.decide(2); // ETH long
    await sys.fundAndConvert(10n * 10n ** 18n);

    const hl = new FakeHl();
    const sim = new SimExchange(hl);
    const across = new FakeAcross();
    across.spoke = sys.spoke;
    const { alerts, sink } = memoryAlerts();
    const cfg = baseConfig({ chainId: BigInt(sys.chainId), vault: sys.vault, governance: sys.governance, reportIntervalMs: 0 });
    const engine = new TradingEngine(sim, hl, alerts, { tradingAccount: HL_ACCOUNT, killSlippageBps: 200, triggerLimitBps: 1000, deadManMs: 120_000, verifyAttempts: 2, verifyDelayMs: 1, sleep: async () => {} }, silentLogger());
    const exec = new LiveExecutor({ writer, reader, engine, across, alerts, vault: sys.vault, chainId: BigInt(sys.chainId), tradingAccount: HL_ACCOUNT, log: silentLogger() });
    const store = new Store();
    const keeper = new Keeper({ cfg, chain: reader, hl, across, exec, store, alerts, log: silentLogger(), keeperAddress: sys.keeper });
    const tick = async () => {
      across.now = await sys.now();
      return keeper.tick();
    };

    // 1. executeDecision: real tx, real MockAcrossSpokePool deposit
    const v0 = await reader.vault();
    expect((await tick()).phase).toBe("execute");
    const run = store.getRun(1n)!;
    expect(run.stage).toBe("bridging");
    expect(run.data.depositId).toBe("0");
    expect(run.data.executeTxHash).toMatch(/^0x/);
    const v1 = await reader.vault();
    expect(v1.position).toMatchObject({ decisionId: 1n, asset: 1, side: "long", capital: v0.maxOrderAmount, depositId: 0n });
    expect(v1.usdgLedger).toBe(v0.usdgLedger - v0.maxOrderAmount);
    expect(await reader.orderExecuted(1n)).toMatchObject({ depositId: 0n, outputAmount: BigInt(run.data.outputAmount!) });
    const capital = v1.position.capital;

    // 2. bridge pending → filled → funding (multisig step simulated by crediting the sim account)
    expect((await tick()).stage).toBe("bridging");
    across.status = { status: "filled" };
    expect((await tick()).stage).toBe("funding");
    expect((await tick()).stage).toBe("funding");
    expect(sink.alerts.some((a) => a.title.includes("multisig action required"))).toBe(true);
    const usdc = (Number(run.data.outputAmount) / 1e6).toFixed(6);
    hl.state = { accountValue: usdc, totalMarginUsed: "0", withdrawable: usdc, positions: [] };
    expect((await tick()).stage).toBe("opening");

    // 3. entry + protection on the simulated exchange
    expect((await tick()).stage).toBe("protecting");
    expect(sim.leverage.get(1)).toEqual({ isCross: false, leverage: 3 });
    expect((await tick()).stage).toBe("holding");
    expect(hl.orders.map((o) => o.orderType)).toEqual(["Stop Market", "Take Profit Market"]);
    const pos = hl.state.positions[0]!;
    expect(pos).toMatchObject({ coin: "ETH", leverageType: "isolated", leverage: 3 });
    // position value ≤ capital × leverage
    expect(Number(pos.positionValue)).toBeLessThanOrEqual((Number(capital) / 1e6) * 3);

    // 4. holding: a real reportPosition (equity = account value)
    hl.state.accountValue = "5000";
    expect((await tick()).stage).toBe("holding");
    const rep = await reader.client.readContract({ address: sys.vault, abi: parseAbi(["function lastReport(uint256) view returns ((uint256 equity, uint64 reportedAt, bool revoked))"]), functionName: "lastReport", args: [1n] });
    expect(rep.equity).toBe(USD(5000));

    // 5. guardian pauses ⇒ mustClose ⇒ unwind on HL ⇒ return plan for the multisig
    await sys.pause(true);
    expect((await reader.vault()).mustClose).toBe(true);
    expect((await tick()).stage).toBe("closed_on_hl");
    expect(hl.state.positions).toEqual([]);
    expect(hl.orders).toEqual([]);
    hl.state.accountValue = "4990";
    hl.state.withdrawable = "4990";
    expect((await tick()).stage).toBe("awaiting_return");
    expect(exec.lastReturnPlan).toContain("RETURN PLAN decision 1: 4990.00 USDC");
    expect(sink.alerts.at(-1)?.title).toMatch(/RETURN REQUIRED/);

    // 6. the multisig bridges back: USDG lands on the vault (mock spoke release) → reportClosed (allowed while paused)
    expect((await tick()).stage).toBe("awaiting_return");
    await sys.returnUsdg(USD(4990));
    expect((await tick()).stage).toBe("report_closed");
    expect((await reader.vault()).position.closeReportedAt).toBeGreaterThan(0);

    // 7. challenge window → finalizeClose measures returned − capital on-chain
    expect((await tick()).phase).toBe("await_finalize");
    await sys.warp(6 * 3600 + 1);
    expect((await tick()).phase).toBe("finalize");
    const v2 = await reader.vault();
    expect(v2.position.decisionId).toBe(0n);
    const pnl = await reader.client.readContract({ address: sys.vault, abi: parseAbi(["function cumulativePnl() view returns (int256)"]), functionName: "cumulativePnl" });
    expect(pnl).toBe(USD(4990) - capital);
    expect(store.getRun(1n)?.stage).toBe("finalized");

    // 8. idle again (paused: nothing executable); a late chunk is reconciled as PnL
    await sys.returnUsdg(USD(10));
    const r = await tick();
    expect(r.phase).toBe("idle");
    expect((await reader.vault()).usdgLedger).toBe(v2.usdgLedger + USD(10));
    const pnl2 = await reader.client.readContract({ address: sys.vault, abi: parseAbi(["function cumulativePnl() view returns (int256)"]), functionName: "cumulativePnl" });
    expect(pnl2).toBe(pnl + USD(10));
  }, 120_000);
});
