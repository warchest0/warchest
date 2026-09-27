import { describe, expect, it } from "vitest";
import {
  bridgeAmount,
  convertAmount,
  decisionExecutable,
  formatUsd6,
  isRefusal,
  isWait,
  maxSafeStopBps,
  planClose,
  planConvert,
  planExecute,
  planOpen,
  planProtect,
  protectionPrices,
} from "../src/planner.js";
import { baseConfig, baseGov, baseLimits, baseVault, NOW, quoteFor, UNIVERSE, USD } from "./fakes.js";

const cfg = baseConfig();
const ETH = 10n ** 18n;

describe("planConvert", () => {
  it("returns nothing below the minimum ETH balance", () => {
    expect(planConvert(baseVault({ ethBalance: 10n ** 16n }), 0n, 0n, cfg, NOW)).toBeUndefined();
  });
  it("caps the amount at maxConvertPerCall and never sets minOut below the on-chain floor", () => {
    const v = baseVault({ ethBalance: 80n * ETH });
    const floor = USD(2600) * 50n;
    const spot = USD(2601) * 50n; // spot barely above floor: spot × (1 − 30 bps) < floor
    const plan = planConvert(v, floor, spot, cfg, NOW);
    expect(plan).toMatchObject({ kind: "convert", amountIn: 50n * ETH, minOut: floor });
  });
  it("uses spot minus slippage when it is above the floor", () => {
    const v = baseVault({ ethBalance: ETH });
    const plan = planConvert(v, USD(2600), USD(2700), cfg, NOW);
    expect(plan).toMatchObject({ kind: "convert", minOut: (USD(2700) * 9970n) / 10_000n });
  });
  it("waits during the cooldown, refuses when paused, waits when spot is below the floor", () => {
    expect(planConvert(baseVault({ ethBalance: ETH, lastConvertAt: NOW - 10 }), USD(2600), USD(2700), cfg, NOW)).toMatchObject({ kind: "wait", until: NOW + 590 });
    expect(planConvert(baseVault({ ethBalance: ETH, paused: true }), USD(2600), USD(2700), cfg, NOW)).toMatchObject({ kind: "refused" });
    expect(planConvert(baseVault({ ethBalance: ETH }), USD(2700), USD(2600), cfg, NOW)).toMatchObject({ kind: "wait" });
  });
  it("convertAmount", () => {
    expect(convertAmount({ ethBalance: 3n * ETH, maxConvertPerCall: 50n * ETH }, ETH)).toBe(3n * ETH);
    expect(convertAmount({ ethBalance: 3n * ETH, maxConvertPerCall: 2n * ETH }, ETH)).toBe(2n * ETH);
    expect(convertAmount({ ethBalance: 3n * ETH, maxConvertPerCall: 50n * ETH }, 4n * ETH)).toBe(0n);
  });
});

describe("decisionExecutable mirrors the vault checks", () => {
  it("accepts a fresh quorate decision", () => {
    expect(decisionExecutable(baseVault(), baseGov(), NOW)).toBeUndefined();
  });
  it("refuses: no decision, already executed, position open, paused, stale", () => {
    expect(decisionExecutable(baseVault(), baseGov({ decision: { ...baseGov().decision, id: 0n } }), NOW)?.reason).toMatch(/no decision/);
    expect(decisionExecutable(baseVault({ lastExecutedDecisionId: 1n }), baseGov(), NOW)?.reason).toMatch(/already executed/);
    expect(decisionExecutable(baseVault({ position: { ...baseVault().position, decisionId: 1n } }), baseGov(), NOW)?.reason).toMatch(/still open/);
    expect(decisionExecutable(baseVault({ paused: true }), baseGov(), NOW)?.reason).toMatch(/paused/);
    expect(decisionExecutable(baseVault(), baseGov({ paused: true }), NOW)?.reason).toMatch(/governance paused/);
    expect(decisionExecutable(baseVault(), baseGov({ round: { endsAt: NOW - 4 * 86_400, finalized: true } }), NOW)?.reason).toMatch(/stale/);
    expect(decisionExecutable(baseVault(), baseGov({ round: undefined }), NOW)?.reason).toMatch(/round/);
  });
});

describe("bridgeAmount", () => {
  it("is the min of cap, ledger and the Across instant limit", () => {
    expect(bridgeAmount({ maxOrderAmount: USD(100_000), usdgLedger: USD(500_000) }, baseLimits())).toBe(USD(100_000));
    expect(bridgeAmount({ maxOrderAmount: USD(100_000), usdgLedger: USD(40_000) }, baseLimits())).toBe(USD(40_000));
    expect(bridgeAmount({ maxOrderAmount: USD(300_000), usdgLedger: USD(500_000) }, baseLimits())).toBe(USD(260_818));
    expect(bridgeAmount({ maxOrderAmount: USD(300_000), usdgLedger: USD(500_000) }, baseLimits({ maxDepositInstant: 0n, maxDeposit: USD(200_000) }))).toBe(USD(200_000));
  });
});

describe("planExecute", () => {
  const amount = USD(100_000);
  it("produces vault-valid parameters", () => {
    const plan = planExecute(baseVault(), baseGov(), UNIVERSE, baseLimits(), quoteFor(amount), amount, cfg, NOW);
    expect(plan).toMatchObject({
      kind: "executeDecision",
      decisionId: 1n,
      asset: 1,
      coin: "ETH",
      side: "long",
      amount,
      outputAmount: USD(99_940),
      quoteTimestamp: NOW - 60,
      fillDeadline: NOW + 7200,
      feeBps: 6,
      expectedDepositId: 373_000n,
    });
  });
  it("refuses an asset outside the allowlist, a delisted asset, an unknown index and too little max leverage", () => {
    const gov = (asset: number) => baseGov({ decision: { ...baseGov().decision, asset } });
    expect(planExecute(baseVault(), gov(2), UNIVERSE, baseLimits(), quoteFor(amount), amount, cfg, NOW)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/allowlist/) });
    expect(planExecute(baseVault(), gov(3), UNIVERSE, baseLimits(), quoteFor(amount), amount, cfg, NOW)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/delisted/) });
    expect(planExecute(baseVault(), gov(99), UNIVERSE, baseLimits(), quoteFor(amount), amount, cfg, NOW)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/unknown/) });
    expect(planExecute(baseVault({ risk: { stopLossBps: 500, leverage: 30, takeProfitBps: 1000 } }), gov(1), UNIVERSE, baseLimits(), quoteFor(amount), amount, cfg, NOW)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/max leverage/) });
  });
  it("waits when the bridge fee exceeds maxBridgeFeeBps and refuses output > input", () => {
    expect(planExecute(baseVault(), baseGov(), UNIVERSE, baseLimits(), quoteFor(amount, NOW, 60n), amount, cfg, NOW)).toMatchObject({ kind: "wait", reason: expect.stringMatching(/fee too high/) });
    expect(planExecute(baseVault(), baseGov(), UNIVERSE, baseLimits(), quoteFor(amount, NOW, 6n, { outputAmount: amount + 1n }), amount, cfg, NOW)).toMatchObject({ kind: "refused" });
  });
  it("enforces the SpokePool timestamp windows and the fill margin", () => {
    expect(planExecute(baseVault(), baseGov(), UNIVERSE, baseLimits(), quoteFor(amount, NOW, 6n, { timestamp: NOW - 3500 }), amount, cfg, NOW)).toMatchObject({ kind: "wait", reason: expect.stringMatching(/quote timestamp/) });
    expect(planExecute(baseVault(), baseGov(), UNIVERSE, baseLimits(), quoteFor(amount, NOW, 6n, { timestamp: NOW + 5 }), amount, cfg, NOW)).toMatchObject({ kind: "wait" });
    expect(planExecute(baseVault(), baseGov(), UNIVERSE, baseLimits(), quoteFor(amount, NOW, 6n, { fillDeadline: NOW + 600 }), amount, cfg, NOW)).toMatchObject({ kind: "wait", reason: expect.stringMatching(/deadline/) });
    expect(planExecute(baseVault(), baseGov(), UNIVERSE, baseLimits(), quoteFor(amount, NOW, 6n, { fillDeadline: NOW + 30_000 }), amount, cfg, NOW)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/buffer/) });
  });
  it("refuses amounts above the cap or the ledger and a foreign spoke pool", () => {
    expect(planExecute(baseVault(), baseGov(), UNIVERSE, baseLimits(), quoteFor(USD(200_000)), USD(200_000), cfg, NOW)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/cap/) });
    expect(planExecute(baseVault({ usdgLedger: USD(10) }), baseGov(), UNIVERSE, baseLimits(), quoteFor(amount), amount, cfg, NOW)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/ledger/) });
    expect(planExecute(baseVault(), baseGov(), UNIVERSE, baseLimits(), quoteFor(amount, NOW, 6n, { spokePoolAddress: "0x0000000000000000000000000000000000000009" }), amount, cfg, NOW)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/spoke pool/) });
    expect(planExecute(baseVault(), baseGov(), UNIVERSE, baseLimits({ minDeposit: USD(1_000_000) }), quoteFor(amount), amount, cfg, NOW)).toMatchObject({ kind: "wait", reason: expect.stringMatching(/minDeposit/) });
    expect(planExecute(baseVault(), baseGov(), UNIVERSE, baseLimits(), quoteFor(amount), 0n, cfg, NOW)).toMatchObject({ kind: "wait" });
  });
});

describe("planOpen", () => {
  const vault = baseVault({ position: { decisionId: 1n, asset: 1, side: "long", capital: USD(100_000), openedAt: NOW, depositId: 5n, closeReportedAt: 0 } });
  const ETHP = UNIVERSE[1]!;
  it("sizes on min(available, capital) × leverage × buffer at the worst IOC price", () => {
    const plan = planOpen(vault, ETHP, "2692.85", "99940", cfg);
    expect(plan).toMatchObject({ kind: "openPosition", coin: "ETH", isBuy: true, leverage: 3, margin: "99940", limitPx: "2706.4" });
    // 99940 × 3 × 0.98 / 2706.4 = 108.5662… → 4 decimals
    expect((plan as { size: string }).size).toBe("108.5662");
  });
  it("never sizes on more than the vault's recorded capital", () => {
    const plan = planOpen(vault, ETHP, "2692.85", "250000", cfg) as { margin: string };
    expect(plan.margin).toBe("100000");
  });
  it("shorts round the limit price down", () => {
    const v = baseVault({ position: { ...vault.position, side: "short" } });
    expect(planOpen(v, ETHP, "2692.85", "1000", cfg)).toMatchObject({ isBuy: false, limitPx: "2679.3" });
  });
  it("refuses: wrong asset, allowlist, leverage, unsafe stop, no mid, no margin, dust", () => {
    expect(planOpen(vault, UNIVERSE[0]!, "84295.5", "1000", cfg)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/asset/) });
    expect(planOpen(vault, ETHP, "2692.85", "1000", baseConfig({ allowedAssets: ["BTC"] }))).toMatchObject({ kind: "refused", reason: expect.stringMatching(/allowlist/) });
    expect(planOpen(baseVault({ ...vault, risk: { stopLossBps: 500, leverage: 26, takeProfitBps: 1000 } }), ETHP, "2692.85", "1000", cfg)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/leverage/) });
    expect(planOpen(baseVault({ ...vault, risk: { stopLossBps: 3000, leverage: 3, takeProfitBps: 1000 } }), ETHP, "2692.85", "1000", cfg)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/stop-loss/) });
    expect(planOpen(vault, ETHP, "0", "1000", cfg)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/mid/) });
    expect(planOpen(vault, ETHP, "2692.85", "0", cfg)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/margin/) });
    expect(planOpen(vault, ETHP, "2692.85", "0.01", cfg)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/zero/) });
    expect(planOpen(baseVault(), ETHP, "2692.85", "1000", cfg)).toMatchObject({ kind: "refused" });
  });
  it("maxSafeStopBps keeps the stop well inside the liquidation distance", () => {
    expect(maxSafeStopBps(3)).toBe(2666);
    expect(maxSafeStopBps(10)).toBe(800);
    expect(maxSafeStopBps(1)).toBe(8000);
  });
});

describe("protection prices", () => {
  it("stop is bps of entry; take-profit is bps of capital divided by leverage", () => {
    expect(protectionPrices("2700", "long", { stopLossBps: 500, leverage: 3, takeProfitBps: 1000 }, 4)).toEqual({ stopLossPx: "2565", takeProfitPx: "2789.9" });
    expect(protectionPrices("2700", "short", { stopLossBps: 500, leverage: 3, takeProfitBps: 1000 }, 4)).toEqual({ stopLossPx: "2835", takeProfitPx: "2610.1" });
  });
  it("rounds the stop away from the entry and the take-profit toward it", () => {
    const r = protectionPrices("84295.5", "long", { stopLossBps: 500, leverage: 3, takeProfitBps: 1000 }, 5);
    expect(r.stopLossPx).toBe("80080"); // 80080.725 → down
    expect(r.takeProfitPx).toBe("87102"); // 87102.25 → down
  });
});

describe("planProtect / planClose", () => {
  const vault = baseVault({ position: { decisionId: 1n, asset: 1, side: "long", capital: USD(100_000), openedAt: NOW, depositId: 5n, closeReportedAt: 0 } });
  const ETHP = UNIVERSE[1]!;
  const pos = { coin: "ETH", szi: "108.5761", leverageType: "isolated" as const, leverage: 3, entryPx: "2693.1", positionValue: "292400", unrealizedPnl: "0", marginUsed: "97466", liquidationPx: "1800" };
  it("covers the whole position with a stop and an optional take-profit", () => {
    expect(planProtect(vault, ETHP, pos, { takeProfitTrigger: true })).toMatchObject({ kind: "protect", size: "108.5761", stopLossPx: "2558.4", takeProfitPx: "2782.7" });
    expect((planProtect(vault, ETHP, pos, { takeProfitTrigger: false }) as { takeProfitPx?: string }).takeProfitPx).toBeUndefined();
  });
  it("refuses a position whose side contradicts the decision, or another coin, or a flat one", () => {
    expect(planProtect(vault, ETHP, { ...pos, szi: "-1" }, { takeProfitTrigger: true })).toMatchObject({ kind: "refused", reason: expect.stringMatching(/side/) });
    expect(planProtect(vault, ETHP, { ...pos, coin: "BTC" }, { takeProfitTrigger: true })).toMatchObject({ kind: "refused" });
    expect(planProtect(vault, ETHP, { ...pos, szi: "0" }, { takeProfitTrigger: true })).toMatchObject({ kind: "refused" });
    expect(planProtect(vault, ETHP, { ...pos, entryPx: undefined }, { takeProfitTrigger: true })).toMatchObject({ kind: "refused" });
  });
  it("closes with the opposite side at a bounded price", () => {
    expect(planClose(ETHP, pos, "2692.85", 50, "test")).toMatchObject({ kind: "closePosition", isBuy: false, size: "108.5761", limitPx: "2679.3" });
    expect(planClose(ETHP, { ...pos, szi: "-2" }, "2692.85", 50, "test")).toMatchObject({ isBuy: true, size: "2", limitPx: "2706.4" });
    expect(planClose(ETHP, { ...pos, szi: "0" }, "2692.85", 50, "test")).toMatchObject({ kind: "refused" });
  });
  it("helpers", () => {
    expect(formatUsd6(USD(99_940))).toBe("99940");
    expect(formatUsd6(1_500_000n)).toBe("1.5");
    expect(formatUsd6(0n)).toBe("0");
    expect(isRefusal({ kind: "refused" })).toBe(true);
    expect(isWait({ kind: "wait" })).toBe(true);
    expect(isRefusal(undefined)).toBe(false);
  });
});
