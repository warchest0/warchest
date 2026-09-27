import { describe, expect, it } from "vitest";
import { checkInvariants, Monitor, type MonitorInput } from "../src/monitor.js";
import type { HlOpenOrder, HlPosition } from "../src/types.js";
import { baseGov, baseVault, FakeChain, FakeHl, HL_ACCOUNT, KEEPER, memoryAlerts, NOW, silentLogger, UNIVERSE, USD } from "./fakes.js";

const vaultPos = { decisionId: 1n, asset: 1, side: "long" as const, capital: USD(100_000), openedAt: NOW, depositId: 1n, closeReportedAt: 0 };
const pos: HlPosition = { coin: "ETH", szi: "108", leverageType: "isolated", leverage: 3, entryPx: "2700", positionValue: "291600", unrealizedPnl: "0", marginUsed: "97200" };
const stop: HlOpenOrder = { coin: "ETH", side: "A", limitPx: "0", sz: "108", origSz: "108", oid: 1, timestamp: 0, isTrigger: true, triggerPx: "2565", triggerCondition: "", isPositionTpsl: true, reduceOnly: true, orderType: "Stop Market", tif: null, cloid: null };
const tp: HlOpenOrder = { ...stop, oid: 2, triggerPx: "2789.9", orderType: "Take Profit Market" };

function input(over: Partial<MonitorInput> = {}): MonitorInput {
  return {
    vault: baseVault({ position: vaultPos, lastExecutedDecisionId: 1n }),
    gov: baseGov(),
    state: { accountValue: "99900", totalMarginUsed: "97200", withdrawable: "2700", positions: [pos] },
    orders: [stop, tp],
    agents: [{ address: KEEPER, name: "warchest", validUntil: NOW * 1000 + 30 * 86_400_000 }],
    universe: UNIVERSE,
    allowedAssets: ["BTC", "ETH", "SOL"],
    agentAddress: KEEPER,
    agentExpiryWarnMs: 3 * 86_400_000,
    sizeToleranceBps: 500,
    now: NOW * 1000,
    ...over,
  };
}
const codes = (i: MonitorInput) => checkInvariants(i).map((f) => `${f.level}:${f.code}`);

describe("checkInvariants", () => {
  it("is silent on a conforming protected position", () => {
    expect(codes(input())).toEqual([]);
  });
  it("flags a position without a vault position, a foreign coin, a non-allowlisted coin", () => {
    expect(codes(input({ vault: baseVault() }))).toEqual(["red:POSITION_WITHOUT_VAULT", "red:UNEXPECTED_ORDER", "red:UNEXPECTED_ORDER"].slice(0, 1).concat(["yellow:UNEXPECTED_ORDER", "yellow:UNEXPECTED_ORDER"]));
    expect(codes(input({ state: { accountValue: "1", totalMarginUsed: "1", withdrawable: "1", positions: [{ ...pos, coin: "BTC" }] }, orders: [] }))).toEqual(["red:FOREIGN_POSITION"]);
    expect(codes(input({ state: { accountValue: "1", totalMarginUsed: "1", withdrawable: "1", positions: [{ ...pos, coin: "DOGE" }] }, orders: [] }))).toEqual(["red:ASSET_NOT_ALLOWED"]);
  });
  it("flags side, margin mode, leverage and size", () => {
    expect(codes(input({ state: { ...input().state, positions: [{ ...pos, szi: "-108" }] }, orders: [{ ...stop, side: "B" }] }))).toContain("red:SIDE_MISMATCH");
    expect(codes(input({ state: { ...input().state, positions: [{ ...pos, leverageType: "cross" }] } }))).toEqual(["red:MARGIN_MODE"]);
    expect(codes(input({ state: { ...input().state, positions: [{ ...pos, leverage: 5 }] } }))).toEqual(["red:LEVERAGE"]);
    expect(codes(input({ state: { ...input().state, positions: [{ ...pos, positionValue: "320000" }] } }))).toEqual(["red:SIZE_EXCEEDS"]);
    expect(codes(input({ state: { ...input().state, positions: [{ ...pos, positionValue: "314000" }] } }))).toEqual([]); // within 5 %
  });
  it("flags a missing stop, a stop beyond the mandated distance, and unexpected orders", () => {
    expect(codes(input({ orders: [tp] }))).toEqual(["red:STOP_MISSING"]);
    expect(codes(input({ orders: [{ ...stop, triggerPx: "2400" }] }))).toEqual(["red:STOP_TOO_FAR"]);
    expect(codes(input({ orders: [{ ...stop, triggerPx: "2560" }] }))).toEqual([]); // 0.5 % slack
    expect(codes(input({ orders: [{ ...stop, triggerPx: "2600" }] }))).toEqual([]); // tighter is fine
    const naked: HlOpenOrder = { ...stop, oid: 9, isTrigger: false, reduceOnly: false, orderType: "Limit" };
    expect(codes(input({ orders: [stop, naked] }))).toEqual(["red:UNEXPECTED_ORDER"]);
    expect(codes(input({ orders: [stop, { ...stop, coin: "BTC", oid: 10 }] }))).toEqual(["yellow:UNEXPECTED_ORDER"]);
  });
  it("flags mustClose (yellow), agent missing (red) and agent expiring (yellow)", () => {
    expect(codes(input({ vault: baseVault({ position: vaultPos, mustClose: true, paused: true }) }))).toEqual(["yellow:MUST_CLOSE"]);
    expect(codes(input({ agents: [] }))).toEqual(["red:AGENT_MISSING"]);
    expect(codes(input({ agents: [{ address: KEEPER, name: "x", validUntil: NOW * 1000 + 1000 }] }))).toEqual(["yellow:AGENT_EXPIRING"]);
    expect(codes(input({ agentAddress: undefined, agents: [] }))).toEqual([]);
  });
  it("ignores dust positions", () => {
    expect(codes(input({ state: { ...input().state, positions: [{ ...pos, szi: "0" }] }, orders: [] }))).toEqual([]);
  });
});

describe("Monitor.run", () => {
  it("alerts once per continuous condition and triggers the kill switch on red when armed", async () => {
    const chain = new FakeChain();
    chain.v = baseVault({ position: vaultPos, lastExecutedDecisionId: 1n });
    const hl = new FakeHl();
    hl.state = { accountValue: "99900", totalMarginUsed: "97200", withdrawable: "2700", positions: [pos] };
    hl.orders = []; // no stop!
    const { alerts, sink } = memoryAlerts();
    const kills: string[] = [];
    const m = new Monitor({ chain, hl, alerts, tradingAccount: HL_ACCOUNT, hlAccount: HL_ACCOUNT, allowedAssets: ["BTC", "ETH", "SOL"], agentExpiryWarnMs: 1, kill: async (r) => (kills.push(r), { done: true, flat: true }), log: silentLogger() });
    const f1 = await m.run();
    expect(f1.map((x) => x.code)).toEqual(["STOP_MISSING"]);
    expect(kills).toEqual(["STOP_MISSING"]);
    expect(sink.alerts).toHaveLength(1);
    await m.run();
    expect(sink.alerts).toHaveLength(1); // same condition, no new alert
    hl.orders = [stop];
    expect(await m.run()).toEqual([]);
    hl.orders = [];
    await m.run();
    expect(sink.alerts).toHaveLength(2); // condition came back
    // without a kill function, red findings only alert
    const m2 = new Monitor({ chain, hl, alerts, tradingAccount: HL_ACCOUNT, hlAccount: HL_ACCOUNT, allowedAssets: ["ETH"], agentExpiryWarnMs: 1, log: silentLogger() });
    expect((await m2.run()).length).toBe(1);
  });
});
