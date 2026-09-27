import { beforeEach, describe, expect, it } from "vitest";
import { cloidFor, isStopFor, TradingEngine } from "../src/hyperliquid/engine.js";
import type { ClosePlan, OpenPlan, ProtectPlan } from "../src/planner.js";
import { Store, type Run } from "../src/store.js";
import { FakeHl, HL_ACCOUNT, memoryAlerts, silentLogger, UNIVERSE } from "./fakes.js";
import { SimExchange } from "./simExchange.js";

const openPlan: OpenPlan = { kind: "openPosition", decisionId: 1n, asset: 1, coin: "ETH", side: "long", isBuy: true, leverage: 3, margin: "99940", limitPx: "2706.4", size: "108.5662", mid: "2692.85", szDecimals: 4 };
const protectPlan: ProtectPlan = { kind: "protect", decisionId: 1n, asset: 1, coin: "ETH", side: "long", size: "108.5662", entryPx: "2706.4", stopLossPx: "2571", takeProfitPx: "2796.5", szDecimals: 4 };
const closePlan: ClosePlan = { kind: "closePosition", asset: 1, coin: "ETH", isBuy: false, size: "108.5662", limitPx: "2679.3", reason: "test" };

function setup() {
  const hl = new FakeHl();
  const sim = new SimExchange(hl);
  const { alerts, sink } = memoryAlerts();
  const sleeps: number[] = [];
  const engine = new TradingEngine(sim, hl, alerts, { tradingAccount: HL_ACCOUNT, killSlippageBps: 200, triggerLimitBps: 1000, deadManMs: 120_000, verifyAttempts: 3, verifyDelayMs: 10, now: () => 1_790_000_000_000, sleep: async (ms) => void sleeps.push(ms) }, silentLogger());
  const store = new Store();
  const run: Run = store.startRun(1n, "opening", { coin: "ETH", side: "long" });
  hl.state = { accountValue: "99940", totalMarginUsed: "0", withdrawable: "99940", positions: [] };
  return { hl, sim, engine, sink, sleeps, store, run };
}

describe("TradingEngine.open", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => (s = setup()));

  it("sets isolated leverage, arms the dead-man switch, sends one IOC with a deterministic cloid, disarms, verifies", async () => {
    const r = await s.engine.open(openPlan, s.run);
    expect(r).toMatchObject({ done: true, filledSize: "108.5662", avgPx: "2706.4", attempts: 1 });
    expect(s.sim.actions()).toEqual(["updateLeverage", "scheduleCancel", "order", "scheduleCancel"]);
    expect(s.sim.leverage.get(1)).toEqual({ isCross: false, leverage: 3 });
    expect(s.sim.scheduled).toBeNull();
    const order = (s.sim.log[2]!.args as { orders: { cloid: string; reduceOnly: boolean; type: unknown }[]; grouping: string });
    expect(order.orders[0]).toMatchObject({ cloid: cloidFor(1n, "entry", 1), reduceOnly: false, type: { limit: { tif: "Ioc" } } });
    expect(order.grouping).toBe("na");
    expect(s.hl.state.positions[0]).toMatchObject({ coin: "ETH", szi: "108.5662", leverageType: "isolated", leverage: 3 });
  });
  it("reports a partial fill and a rejection", async () => {
    s.sim.fillRatioBps = 5000;
    expect(await s.engine.open(openPlan, s.run)).toMatchObject({ filledSize: "54.2831" });
    const t = setup();
    t.sim.rejectEntry = "Insufficient margin";
    expect(await t.engine.open(openPlan, t.run)).toMatchObject({ filledSize: "0", note: "Insufficient margin", attempts: 1 });
  });
  it("never re-sends an entry whose cloid already exists (crash between send and persist)", async () => {
    s.hl.statuses.set(cloidFor(1n, "entry", 1), { status: "order", state: "filled", order: { oid: 42 } as never });
    s.hl.state.positions.push({ coin: "ETH", szi: "50", leverageType: "isolated", leverage: 3, entryPx: "2700", positionValue: "135000", unrealizedPnl: "0", marginUsed: "45000" });
    const r = await s.engine.open(openPlan, s.run);
    expect(r).toMatchObject({ done: true, filledSize: "50", avgPx: "2700", oids: [42], note: "entry already existed" });
    expect(s.sim.actions()).toEqual([]);
  });
  it("uses the next attempt's cloid after a failed attempt", async () => {
    s.run.data.entryAttempts = 2;
    await s.engine.open(openPlan, s.run);
    const order = s.sim.log[2]!.args as { orders: { cloid: string }[] };
    expect(order.orders[0]!.cloid).toBe(cloidFor(1n, "entry", 3));
  });
  it("flattens a fill whose margin mode is not isolated (fail-closed)", async () => {
    s.sim.forceCross = true;
    const r = await s.engine.open(openPlan, s.run);
    expect(r).toMatchObject({ filledSize: "0", note: "leverage mismatch, flattened" });
    expect(s.hl.state.positions).toEqual([]);
    expect(s.sink.alerts.at(-1)?.title).toMatch(/margin mode/);
  });
  it("flattens when the dead-man switch cannot be disarmed after the fill", async () => {
    s.sim.scheduleDisarmRejects = true;
    const r = await s.engine.open(openPlan, s.run);
    expect(r).toMatchObject({ filledSize: "0", note: "disarm failed, flattened" });
    expect(s.hl.state.positions).toEqual([]);
    expect(s.sim.actions().filter((a) => a === "scheduleCancel")).toHaveLength(4); // arm + 3 disarm attempts
  });
  it("proceeds without the dead-man switch when the account may not schedule cancels", async () => {
    s.sim.scheduleArmRejects = true;
    const r = await s.engine.open(openPlan, s.run);
    expect(r.filledSize).toBe("108.5662");
    expect(s.sim.actions()).toEqual(["updateLeverage", "scheduleCancel", "order"]);
  });
});

describe("TradingEngine.protect", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    await s.engine.open(openPlan, s.run);
    s.sim.log = [];
  });

  it("places reduce-only stop and take-profit triggers on the opposite side (positionTpsl) and reads the stop back", async () => {
    const r = await s.engine.protect(protectPlan, s.run);
    expect(r).toMatchObject({ done: true, verified: true, attempts: 1 });
    expect(r.stopLossOid).toBeDefined();
    expect(r.takeProfitOid).toBeDefined();
    const args = s.sim.log[0]!.args as { orders: Record<string, unknown>[]; grouping: string };
    expect(args.grouping).toBe("positionTpsl");
    expect(args.orders[0]).toMatchObject({ asset: 1, isBuy: false, reduceOnly: true, size: "108.5662", limitPx: "2313.9", type: { trigger: { isMarket: true, triggerPx: "2571", tpsl: "sl" } }, cloid: cloidFor(1n, "sl", 1) });
    expect(args.orders[1]).toMatchObject({ isBuy: false, reduceOnly: true, limitPx: "2516.8", type: { trigger: { isMarket: true, triggerPx: "2796.5", tpsl: "tp" } }, cloid: cloidFor(1n, "tp", 1) });
    expect(s.hl.orders.map((o) => o.orderType)).toEqual(["Stop Market", "Take Profit Market"]);
  });
  it("shorts: triggers are buys with limit room above the trigger", async () => {
    const r = await s.engine.protect({ ...protectPlan, side: "short", stopLossPx: "2841", takeProfitPx: "2616.3" }, s.run);
    expect(r.verified).toBe(true); // verification is against the plan (the planner already matched side vs position)
    const args = s.sim.log[0]!.args as { orders: Record<string, unknown>[] };
    expect(args.orders[0]).toMatchObject({ isBuy: true, limitPx: "3125.1", type: { trigger: { triggerPx: "2841", tpsl: "sl" } } });
  });
  it("is idempotent: an open stop with the same cloid is not re-placed", async () => {
    await s.engine.protect(protectPlan, s.run);
    s.sim.log = [];
    const r = await s.engine.protect(protectPlan, s.run);
    expect(r.verified).toBe(true);
    expect(s.sim.actions()).toEqual([]);
  });
  it("stop only when the take-profit trigger is disabled", async () => {
    const r = await s.engine.protect({ ...protectPlan, takeProfitPx: undefined }, s.run);
    expect(r.verified).toBe(true);
    expect(r.takeProfitOid).toBeUndefined();
    expect(s.hl.orders).toHaveLength(1);
  });
  it("reports verified=false when the API rejects the triggers or when the read-back does not show the stop", async () => {
    s.sim.rejectTriggers = true;
    expect((await s.engine.protect(protectPlan, s.run)).verified).toBe(false);
    const t = setup();
    await t.engine.open(openPlan, t.run);
    t.sim.hideTriggersFromReadback = true;
    const r = await t.engine.protect(protectPlan, t.run);
    expect(r.verified).toBe(false);
    expect(t.sleeps).toEqual([10, 10]); // 3 read-back attempts
  });
  it("isStopFor checks coin, trigger, reduce-only, side, price and size", () => {
    const o = { coin: "ETH", side: "A" as const, limitPx: "0", sz: "108.5662", origSz: "108.5662", oid: 1, timestamp: 0, isTrigger: true, triggerPx: "2571", triggerCondition: "", isPositionTpsl: false, reduceOnly: true, orderType: "Stop Market", tif: null, cloid: null };
    expect(isStopFor(o, protectPlan)).toBe(true);
    expect(isStopFor({ ...o, sz: "1", isPositionTpsl: true }, protectPlan)).toBe(true);
    expect(isStopFor({ ...o, sz: "1" }, protectPlan)).toBe(false);
    expect(isStopFor({ ...o, side: "B" }, protectPlan)).toBe(false);
    expect(isStopFor({ ...o, triggerPx: "2570" }, protectPlan)).toBe(false);
    expect(isStopFor({ ...o, reduceOnly: false }, protectPlan)).toBe(false);
    expect(isStopFor({ ...o, isTrigger: false }, protectPlan)).toBe(false);
    expect(isStopFor({ ...o, orderType: "Take Profit Market" }, protectPlan)).toBe(false);
    expect(isStopFor({ ...o, coin: "BTC" }, protectPlan)).toBe(false);
    expect(isStopFor({ ...o, cloid: "0x00000000000000000000000000000002" }, protectPlan, "0x00000000000000000000000000000001", 9)).toBe(false);
    expect(isStopFor({ ...o, cloid: "0x00000000000000000000000000000002" }, protectPlan, "0x00000000000000000000000000000001", 1)).toBe(true);
  });
});

describe("TradingEngine.close / killSwitch", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    await s.engine.open(openPlan, s.run);
    await s.engine.protect(protectPlan, s.run);
    s.sim.log = [];
  });

  it("cancels the coin's orders then sends a reduce-only IOC; flat when nothing remains", async () => {
    const r = await s.engine.close(closePlan, s.run);
    expect(r).toMatchObject({ done: true, flat: true });
    expect(s.sim.actions()).toEqual(["cancel", "order"]);
    expect((s.sim.log[1]!.args as { orders: { reduceOnly: boolean }[] }).orders[0]!.reduceOnly).toBe(true);
    expect(s.hl.orders).toEqual([]);
    expect(s.hl.state.positions).toEqual([]);
  });
  it("reports flat=false on a partial exit", async () => {
    s.sim.fillRatioBps = 5000;
    expect((await s.engine.close(closePlan, s.run)).flat).toBe(false);
    expect(s.hl.state.positions[0]?.szi).toBe("54.2831");
  });
  it("kill switch cancels everything and flattens every position on every coin", async () => {
    s.hl.state.positions.push({ coin: "BTC", szi: "-0.5", leverageType: "cross", leverage: 10, entryPx: "84000", positionValue: "42000", unrealizedPnl: "0", marginUsed: "4200" });
    s.hl.orders.push({ coin: "SOL", side: "B", limitPx: "100", sz: "1", origSz: "1", oid: 999, timestamp: 0, isTrigger: false, triggerPx: "0", triggerCondition: "", isPositionTpsl: false, reduceOnly: false, orderType: "Limit", tif: "Gtc", cloid: null });
    const r = await s.engine.killSwitch("test");
    expect(r.flat).toBe(true);
    expect(s.sim.actions()).toEqual(["cancel", "order", "order"]);
    expect((s.sim.log[0]!.args as unknown[]).length).toBe(3); // SL, TP, SOL order
    const btc = (s.sim.log[2]!.args as { orders: { isBuy: boolean; reduceOnly: boolean; limitPx: string }[] }).orders[0]!;
    expect(btc).toMatchObject({ isBuy: true, reduceOnly: true, limitPx: "85982" }); // 84295.5 × 1.02 rounded up
    expect(s.hl.orders).toEqual([]);
    expect(s.hl.state.positions).toEqual([]);
    expect(s.sink.alerts[0]?.title).toBe("KILL SWITCH");
  });
  it("kill switch alerts when a position survives", async () => {
    s.sim.fillRatioBps = 1000;
    const r = await s.engine.killSwitch("test");
    expect(r.flat).toBe(false);
    expect(s.sink.alerts.at(-1)?.title).toMatch(/positions remain/);
  });
  it("cloids are 16 bytes and differ per purpose/attempt", () => {
    expect(cloidFor(1n, "entry", 1)).toMatch(/^0x[0-9a-f]{32}$/);
    expect(cloidFor(1n, "entry", 1)).not.toBe(cloidFor(1n, "entry", 2));
    expect(cloidFor(1n, "sl", 1)).not.toBe(cloidFor(2n, "sl", 1));
    expect(UNIVERSE[1]!.name).toBe("ETH");
  });
});
