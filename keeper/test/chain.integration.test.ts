import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RpcChainReader } from "../src/chain/reader.js";
import { DryRunExecutor } from "../src/executor.js";
import { Keeper } from "../src/keeper.js";
import { QUOTER_V2 } from "../src/config.js";
import { Store } from "../src/store.js";
import { anvilReady, startAnvilSystem, type AnvilSystem } from "./anvilSystem.js";
import { baseConfig, FakeAcross, FakeHl, memoryAlerts, silentLogger, USD } from "./fakes.js";

/**
 * The keeper's chain reader against the REAL WarchestGovernance + WarchestVault on anvil: ABI decoding of every
 * view the keeper depends on, a real quorate decision, a real conversion, and a dry-run tick planning
 * `executeDecision` with parameters the vault accepts.
 */
describe.skipIf(!anvilReady())("chain reader ↔ real contracts (anvil)", () => {
  let sys: AnvilSystem;
  let reader: RpcChainReader;
  beforeAll(async () => {
    sys = await startAnvilSystem();
    reader = new RpcChainReader(sys.rpc, sys.vault, sys.governance, QUOTER_V2);
  }, 60_000);
  afterAll(() => sys?.stop());

  it("reads an empty vault and no decision", async () => {
    const v = await reader.vault();
    expect(v).toMatchObject({ paused: false, keeper: sys.keeper, usdgLedger: 0n, nav: 0n, bridgeRecipient: "0x00000000000000000000000000000000000000A1", destinationChainId: 999n, risk: { stopLossBps: 500, leverage: 3, takeProfitBps: 1000 } });
    expect(v.position.decisionId).toBe(0n);
    expect(v.mustClose).toBe(false);
    const g = await reader.governance();
    expect(g.decision.id).toBe(0n);
    expect(g.round).toBeUndefined();
  });

  it("reads a real decision, a real conversion, and plans executeDecision in dry-run", async () => {
    const id = await sys.decide(3); // option 3 = asset index 1 (ETH), side 1 = short
    expect(id).toBe(1n);
    const g = await reader.governance();
    expect(g.decision).toMatchObject({ id: 1n, asset: 1, side: "short", roundId: 1n });
    expect(g.round?.finalized).toBe(true);
    expect(g.closeRequested).toBe(false);

    await sys.fundAndConvert(10n * 10n ** 18n);
    const v = await reader.vault();
    expect(v.usdgLedger).toBeGreaterThan(USD(26_000));
    expect(v.usdgLedger).toBeLessThan(USD(27_100));
    expect(v.nav).toBe(v.usdgLedger);
    expect(v.maxOrderAmount).toBe((v.nav * 2000n) / 10_000n);
    expect(await reader.twapFloor(10n ** 18n)).toBeGreaterThan(USD(2600));
    expect(await reader.orderExecuted(1n)).toBeUndefined();

    const hl = new FakeHl();
    const across = new FakeAcross();
    across.now = v.blockTimestamp;
    across.spoke = sys.spoke;
    const dry = new DryRunExecutor(silentLogger());
    const keeper = new Keeper({
      cfg: baseConfig({ chainId: BigInt(sys.chainId), vault: sys.vault, governance: sys.governance }),
      chain: reader,
      hl,
      across,
      exec: dry,
      store: new Store(),
      alerts: memoryAlerts().alerts,
      log: silentLogger(),
    });
    const r = await keeper.tick();
    expect(r.phase).toBe("execute");
    expect(dry.planned[0]?.action).toBe("executeDecision");
    const plan = dry.planned[0]?.plan as { amount: bigint; outputAmount: bigint; coin: string; side: string; asset: number };
    expect(plan).toMatchObject({ amount: v.maxOrderAmount, coin: "ETH", side: "short", asset: 1 });
    expect(plan.outputAmount).toBe(plan.amount - (plan.amount * 6n) / 10_000n);
  }, 60_000);
});
