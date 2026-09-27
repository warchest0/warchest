import { beforeEach, describe, expect, it } from "vitest";
import { DryRunExecutor } from "../src/executor.js";
import { Keeper } from "../src/keeper.js";
import { Store } from "../src/store.js";
import type { HlOpenOrder } from "../src/types.js";
import { baseConfig, baseGov, baseVault, FakeAcross, FakeChain, FakeHl, HL_ACCOUNT, KEEPER, memoryAlerts, NOW, ScriptedExecutor, silentLogger, USD } from "./fakes.js";

const openPosition = (over: Partial<ReturnType<typeof baseVault>["position"]> = {}) => ({
  decisionId: 1n,
  asset: 1,
  side: "long" as const,
  capital: USD(100_000),
  openedAt: NOW - 600,
  depositId: 373_000n,
  closeReportedAt: 0,
  ...over,
});

const stopOrder: HlOpenOrder = {
  coin: "ETH",
  side: "A",
  limitPx: "0",
  sz: "108.5761",
  origSz: "108.5761",
  oid: 2,
  timestamp: 0,
  isTrigger: true,
  triggerPx: "2558.4",
  triggerCondition: "Price below 2558.4",
  isPositionTpsl: true,
  reduceOnly: true,
  orderType: "Stop Market",
  tif: null,
  cloid: null,
};

function harness(over: { cfg?: Partial<ReturnType<typeof baseConfig>>; now?: number } = {}) {
  const chain = new FakeChain();
  const hl = new FakeHl();
  const across = new FakeAcross();
  const exec = new ScriptedExecutor();
  const store = new Store();
  const { alerts, sink } = memoryAlerts();
  let wall = (over.now ?? NOW) * 1000;
  const keeper = new Keeper({
    cfg: baseConfig(over.cfg),
    chain,
    hl,
    across,
    exec,
    store,
    alerts,
    log: silentLogger(),
    keeperAddress: KEEPER,
    now: () => wall,
  });
  return { chain, hl, across, exec, store, sink, keeper, advance: (ms: number) => (wall += ms) };
}

describe("Keeper: idle duties", () => {
  it("executes a fresh decision with Across-quoted parameters and starts a run", async () => {
    const h = harness();
    const r = await h.keeper.tick();
    expect(r.phase).toBe("execute");
    expect(h.exec.methods()).toEqual(["executeDecision"]);
    const plan = h.exec.calls[0]!.args[0] as { amount: bigint; outputAmount: bigint; quoteTimestamp: number; coin: string };
    expect(plan).toMatchObject({ amount: USD(100_000), outputAmount: USD(99_940), quoteTimestamp: NOW - 60, coin: "ETH" });
    expect(h.across.quotes[0]?.route).toMatchObject({ originChainId: 4663n, destinationChainId: 999n });
    expect(h.store.getRun(1n)).toMatchObject({ stage: "bridging", data: { coin: "ETH", side: "long", capital: USD(100_000).toString(), depositId: "373000", executeTxHash: "0x02" } });
  });
  it("stays idle when there is nothing executable, converts ETH and reconciles stray USDG", async () => {
    const h = harness();
    h.chain.g = baseGov({ decision: { ...baseGov().decision, id: 0n } });
    h.chain.v = baseVault({ ethBalance: 2n * 10n ** 18n, usdgBalance: USD(500_100) });
    const r = await h.keeper.tick();
    expect(r.phase).toBe("idle");
    expect(h.exec.methods()).toEqual(["reconcile", "convert"]);
    expect(h.exec.calls[0]!.args[0]).toBe(USD(100));
    expect(h.exec.calls[1]!.args[0]).toMatchObject({ amountIn: 2n * 10n ** 18n, minOut: (USD(2690) * 2n * 9970n) / 10_000n });
  });
  it("refuses everything when the configured key is not the vault keeper", async () => {
    const h = harness();
    h.chain.v = baseVault({ keeper: HL_ACCOUNT });
    const r = await h.keeper.tick();
    expect(r.phase).toBe("misconfigured");
    expect(h.exec.calls).toEqual([]);
    expect(h.sink.alerts[0]).toMatchObject({ severity: "critical" });
  });
  it("in dry-run nothing is persisted and the same plan is logged every tick", async () => {
    const h = harness();
    const dry = new DryRunExecutor(silentLogger());
    const keeper = new Keeper({ cfg: baseConfig(), chain: h.chain, hl: h.hl, across: h.across, exec: dry, store: h.store, alerts: memoryAlerts().alerts, log: silentLogger() });
    await keeper.tick();
    await keeper.tick();
    expect(dry.planned.map((p) => p.action)).toEqual(["executeDecision", "executeDecision"]);
    expect(h.store.runs()).toEqual([]);
  });
});

describe("Keeper: position lifecycle", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.keeper.tick(); // executeDecision → run bridging
    h.chain.v = baseVault({ position: openPosition(), usdgLedger: USD(400_000), usdgBalance: USD(400_000), lastExecutedDecisionId: 1n });
    h.exec.calls = [];
  });

  it("bridging → funding → opening → protecting → holding, then reports equity", async () => {
    expect((await h.keeper.tick()).stage).toBe("bridging");
    h.across.status = { status: "filled" };
    expect((await h.keeper.tick()).stage).toBe("funding");
    // multisig has not moved the funds yet: instructions are alerted once
    expect((await h.keeper.tick()).stage).toBe("funding");
    await h.keeper.tick();
    expect(h.sink.alerts.filter((a) => a.title.includes("multisig action required"))).toHaveLength(1);
    h.hl.state = { accountValue: "99940", totalMarginUsed: "0", withdrawable: "99940", positions: [] };
    expect((await h.keeper.tick()).stage).toBe("opening");
    // opening: the executor fills the IOC
    expect((await h.keeper.tick()).stage).toBe("protecting");
    const open = h.exec.calls.find((c) => c.method === "open")!.args[0] as { size: string; limitPx: string; leverage: number; margin: string };
    expect(open).toMatchObject({ leverage: 3, margin: "99940", limitPx: "2706.4", size: "108.5662" });
    h.hl.state = {
      accountValue: "99900",
      totalMarginUsed: "97466",
      withdrawable: "2000",
      positions: [{ coin: "ETH", szi: "108.5761", leverageType: "isolated", leverage: 3, entryPx: "2693.1", positionValue: "292400", unrealizedPnl: "-40", marginUsed: "97466" }],
    };
    expect((await h.keeper.tick()).stage).toBe("holding");
    const protect = h.exec.calls.find((c) => c.method === "protect")!.args[0] as { stopLossPx: string; takeProfitPx: string; size: string };
    expect(protect).toMatchObject({ stopLossPx: "2558.4", takeProfitPx: "2782.7", size: "108.5761" });
    expect(h.store.getRun(1n)?.data).toMatchObject({ stopLossOid: 2, takeProfitOid: 3, stopLossPx: "2558.4" });
    // holding: first tick reports equity (interval elapsed since epoch 0)
    h.hl.orders = [stopOrder];
    expect((await h.keeper.tick()).stage).toBe("holding");
    const report = h.exec.calls.find((c) => c.method === "reportPosition")!;
    expect(report.args).toEqual([1n, USD(99_900)]);
    h.exec.calls = [];
    await h.keeper.tick();
    expect(h.exec.methods()).toEqual([]); // not due yet
    h.advance(7 * 3_600_000);
    await h.keeper.tick();
    expect(h.exec.methods()).toEqual(["reportPosition"]);
  });

  it("holding: a missing stop-loss triggers re-protection; an unverified stop flattens (fail-closed)", async () => {
    h.store.transition(1n, "holding", {});
    h.hl.state = {
      accountValue: "99900",
      totalMarginUsed: "97466",
      withdrawable: "2000",
      positions: [{ coin: "ETH", szi: "108.5761", leverageType: "isolated", leverage: 3, entryPx: "2693.1", positionValue: "292400", unrealizedPnl: "-40", marginUsed: "97466" }],
    };
    h.hl.orders = [];
    expect((await h.keeper.tick()).stage).toBe("protecting");
    expect(h.sink.alerts.at(-1)?.title).toMatch(/stop-loss missing/);
    h.exec.results.protect = { done: true, verified: false };
    expect((await h.keeper.tick()).stage).toBe("closed_on_hl");
    expect(h.exec.methods()).toEqual(["protect", "close"]);
    expect(h.sink.alerts.at(-1)?.title).toMatch(/could not be verified/);
  });

  it("mustClose while holding → closing → closed_on_hl → return instructions → reportClosed when USDG is back → finalize", async () => {
    h.store.transition(1n, "holding", {});
    const pos = { coin: "ETH", szi: "108.5761", leverageType: "isolated" as const, leverage: 3, entryPx: "2693.1", positionValue: "292400", unrealizedPnl: "-40", marginUsed: "97466" };
    h.hl.state = { accountValue: "99900", totalMarginUsed: "97466", withdrawable: "2000", positions: [pos] };
    h.hl.orders = [stopOrder];
    h.chain.v = baseVault({ position: openPosition(), mustClose: true, lastExecutedDecisionId: 1n, usdgLedger: USD(400_000), usdgBalance: USD(400_000) });
    h.chain.g = baseGov({ closeRequested: true });
    expect((await h.keeper.tick()).stage).toBe("closed_on_hl"); // close executor reports flat
    expect(h.exec.methods()).toEqual(["close"]);
    expect(h.store.getRun(1n)?.data.closeReason).toBe("close voted");
    h.hl.state = { accountValue: "99850", totalMarginUsed: "0", withdrawable: "99850", positions: [] };
    expect((await h.keeper.tick()).stage).toBe("awaiting_return");
    expect(h.exec.calls.at(-1)).toMatchObject({ method: "returnInstructions", args: [{ decisionId: 1n, equity: USD(99_850), coin: "ETH" }] });
    // nothing back yet: wait; after the timeout: escalate
    expect((await h.keeper.tick()).stage).toBe("awaiting_return");
    expect(h.exec.methods().filter((m) => m === "reportClosed")).toEqual([]);
    h.advance(25 * 3_600_000);
    await h.keeper.tick();
    expect(h.sink.alerts.at(-1)?.title).toMatch(/not back after/);
    // partial return below tolerance: still waiting
    h.chain.v.usdgBalance = USD(400_000) + USD(90_000);
    expect((await h.keeper.tick()).stage).toBe("awaiting_return");
    // 95 % back: report closed
    h.chain.v.usdgBalance = USD(400_000) + USD(94_900);
    expect((await h.keeper.tick()).stage).toBe("report_closed");
    expect(h.exec.calls.at(-1)).toMatchObject({ method: "reportClosed", args: [1n] });
    // on-chain: closeReportedAt set; challenge window
    h.chain.v = baseVault({ position: openPosition({ closeReportedAt: NOW }), lastExecutedDecisionId: 1n, blockTimestamp: NOW + 100 });
    expect((await h.keeper.tick()).phase).toBe("await_finalize");
    h.chain.v.blockTimestamp = NOW + 6 * 3600;
    expect((await h.keeper.tick()).phase).toBe("finalize");
    expect(h.exec.calls.at(-1)).toMatchObject({ method: "finalizeClose", args: [1n] });
    expect(h.store.getRun(1n)?.stage).toBe("finalized");
  });

  it("FORCE_REPORT_CLOSED_ID overrides the return threshold (guardian-visible override)", async () => {
    const f = harness({ cfg: { forceReportClosedId: 1n } });
    f.chain.v = baseVault({ position: openPosition(), lastExecutedDecisionId: 1n });
    f.store.startRun(1n, "awaiting_return", { finalEquity: USD(50_000).toString(), returnPlanIssuedAt: NOW * 1000 });
    expect((await f.keeper.tick()).stage).toBe("report_closed");
  });

  it("position closed by the stop on Hyperliquid → closed_on_hl with a warning", async () => {
    h.store.transition(1n, "holding", {});
    h.hl.state = { accountValue: "85000", totalMarginUsed: "0", withdrawable: "85000", positions: [] };
    expect((await h.keeper.tick()).stage).toBe("closed_on_hl");
    expect(h.sink.alerts.at(-1)?.title).toMatch(/closed on Hyperliquid/);
  });

  it("bridge refunded before any trade → awaiting_return with the capital as expected return", async () => {
    h.across.status = { status: "refunded" };
    expect((await h.keeper.tick()).stage).toBe("awaiting_return");
    expect(h.store.getRun(1n)?.data.finalEquity).toBe(USD(100_000).toString());
  });

  it("mustClose while funding (no position yet) → closed_on_hl, and entry attempts are bounded", async () => {
    h.store.transition(1n, "funding", {});
    h.chain.v.mustClose = true;
    h.chain.v.paused = true;
    // closed_on_hl, then return instructions are issued in the same tick
    expect((await h.keeper.tick()).stage).toBe("awaiting_return");
    expect(h.store.getRun(1n)?.data.closeReason).toMatch(/before any position/);
    // entry attempts
    const g = harness();
    g.chain.v = baseVault({ position: openPosition(), lastExecutedDecisionId: 1n });
    g.store.startRun(1n, "opening", { entryAttempts: 5 });
    g.hl.state = { accountValue: "99940", totalMarginUsed: "0", withdrawable: "99940", positions: [] };
    expect((await g.keeper.tick()).stage).toBe("opening");
    expect(g.exec.calls).toEqual([]);
    expect(g.sink.alerts.at(-1)?.title).toMatch(/entry attempts exhausted/);
  });

  it("unfilled IOC keeps the stage and counts the attempt; partial fill goes to protecting", async () => {
    h.store.transition(1n, "opening", {});
    h.hl.state = { accountValue: "99940", totalMarginUsed: "0", withdrawable: "99940", positions: [] };
    h.exec.results.open = { done: true, filledSize: "0", attempts: 1, oids: [9] };
    expect((await h.keeper.tick()).stage).toBe("opening");
    expect(h.store.getRun(1n)?.data.entryAttempts).toBe(1);
    h.exec.results.open = { done: true, filledSize: "10", avgPx: "2693", attempts: 2, oids: [9, 10] };
    expect((await h.keeper.tick()).stage).toBe("protecting");
  });

  it("adopts a position it has no run for, from chain + Hyperliquid state", async () => {
    const f = harness();
    f.chain.v = baseVault({ position: openPosition(), lastExecutedDecisionId: 1n });
    f.chain.executed = { outputAmount: USD(99_940), depositId: 373_000n, blockNumber: 1n };
    f.hl.state = { accountValue: "99900", totalMarginUsed: "97466", withdrawable: "2000", positions: [{ coin: "ETH", szi: "108", leverageType: "isolated", leverage: 3, entryPx: "2693", positionValue: "1", unrealizedPnl: "0", marginUsed: "1" }] };
    const r = await f.keeper.tick();
    expect(r.stage).toBe("holding"); // adopted at protecting, protect verified → holding
    expect(f.store.getRun(1n)?.data).toMatchObject({ outputAmount: USD(99_940).toString(), notes: ["adopted from chain state"] });
    expect(f.sink.alerts[0]?.title).toMatch(/adopted/);
    // no HL position, no funds, deposit filled → funding
    const g = harness();
    g.chain.v = baseVault({ position: openPosition(), lastExecutedDecisionId: 1n });
    g.across.status = { status: "filled" };
    await g.keeper.tick();
    expect(g.store.getRun(1n)?.stage).toBe("funding");
    expect(g.store.getRun(1n)?.data.outputAmount).toBe(USD(99_500).toString()); // capital × (1 − maxBridgeFeeBps)
  });

  it("alerts on foreign positions and on an asset outside the allowlist", async () => {
    h.store.transition(1n, "holding", {});
    h.hl.state = { accountValue: "1", totalMarginUsed: "0", withdrawable: "1", positions: [{ coin: "DOGE", szi: "1", leverageType: "cross", leverage: 20, positionValue: "1", unrealizedPnl: "0", marginUsed: "1" }] };
    await h.keeper.tick();
    expect(h.sink.alerts.some((a) => a.title.includes("unexpected positions"))).toBe(true);
    const g = harness({ cfg: { allowedAssets: ["BTC"] } });
    g.chain.v = baseVault({ position: openPosition(), lastExecutedDecisionId: 1n });
    g.store.startRun(1n, "bridging", {});
    await g.keeper.tick();
    expect(g.sink.alerts.some((a) => a.title.includes("outside the keeper allowlist"))).toBe(true);
  });

  it("agent expiry: missing agent is critical, near expiry is a warning", async () => {
    const f = harness();
    const keeper = new Keeper({ cfg: baseConfig(), chain: f.chain, hl: f.hl, across: f.across, exec: f.exec, store: f.store, alerts: f.sink && memoryAlerts().alerts, log: silentLogger(), agentAddress: KEEPER, now: () => NOW * 1000 });
    const { alerts, sink } = memoryAlerts();
    const k2 = new Keeper({ cfg: baseConfig(), chain: f.chain, hl: f.hl, across: f.across, exec: f.exec, store: f.store, alerts, log: silentLogger(), agentAddress: KEEPER, now: () => NOW * 1000 });
    void keeper;
    await k2.tick();
    expect(sink.alerts[0]?.title).toMatch(/agent not approved/);
    f.hl.agents = [{ address: KEEPER, name: "warchest", validUntil: NOW * 1000 + 3_600_000 }];
    await k2.tick();
    expect(sink.alerts.some((a) => a.title.includes("expires soon"))).toBe(true);
  });
});
