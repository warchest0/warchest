import { describe, expect, it } from "vitest";
import { HYPEREVM_CHAIN_ID, USDC_HYPEREVM, USDG_ROBINHOOD } from "../src/across/api.js";
import { classifyDeposit, formatReturnPlan, outboundRoute, planReturn, returnRoute, splitReturn } from "../src/across/bridge.js";
import { baseLimits, baseVault, FakeAcross, HL_ACCOUNT, NOW, USD, VAULT } from "./fakes.js";

describe("routes", () => {
  it("outbound and return routes are mirror images of the vault's immutable bridge", () => {
    const v = baseVault();
    expect(outboundRoute(v, 4663n)).toEqual({ inputToken: USDG_ROBINHOOD, outputToken: USDC_HYPEREVM, originChainId: 4663n, destinationChainId: HYPEREVM_CHAIN_ID });
    expect(returnRoute(v, 4663n)).toEqual({ inputToken: USDC_HYPEREVM, outputToken: USDG_ROBINHOOD, originChainId: HYPEREVM_CHAIN_ID, destinationChainId: 4663n });
  });
});

describe("classifyDeposit", () => {
  const v = baseVault({ usdgBalance: USD(400_000), usdgLedger: USD(400_000), blockTimestamp: NOW });
  const capital = USD(100_000);
  it("follows the API for filled / refunded / pending", () => {
    expect(classifyDeposit({ status: "filled" }, v, capital, NOW + 7200)).toEqual({ state: "filled" });
    expect(classifyDeposit({ status: "refunded" }, v, capital)).toMatchObject({ state: "refunded" });
    expect(classifyDeposit({ status: "pending" }, v, capital, NOW + 7200)).toMatchObject({ state: "pending", reason: "waiting for a relayer" });
    expect(classifyDeposit({ status: "unknown" }, v, capital, NOW + 7200)).toMatchObject({ state: "pending", reason: expect.stringMatching(/not indexed/) });
  });
  it("detects a refund from the vault balance before the API says so, and an expiry from the deadline", () => {
    expect(classifyDeposit({ status: "pending" }, { ...v, usdgBalance: USD(500_000) }, capital)).toMatchObject({ state: "refunded" });
    expect(classifyDeposit({ status: "pending" }, { ...v, usdgBalance: USD(450_000) }, capital)).toMatchObject({ state: "pending" });
    expect(classifyDeposit({ status: "expired" }, v, capital)).toMatchObject({ state: "expired" });
    expect(classifyDeposit({ status: "pending" }, v, capital, NOW - 1000)).toMatchObject({ state: "expired", reason: expect.stringMatching(/deadline/) });
    expect(classifyDeposit({ status: "pending" }, v, capital, NOW - 100)).toMatchObject({ state: "pending" }); // 15 min grace
  });
});

describe("splitReturn", () => {
  const limits = baseLimits({ minDeposit: USD(0.5), maxDepositInstant: USD(246_229), maxDeposit: USD(246_229) });
  it("keeps a small return in one deposit", () => {
    expect(splitReturn(USD(99_850), limits)).toEqual({ chunks: [USD(99_850)], warnings: [] });
  });
  it("splits a large return at the instant limit (≈ 278k$ finding of RESEARCH §3.2)", () => {
    const r = splitReturn(USD(500_000), limits);
    expect(r.chunks).toEqual([USD(246_229), USD(246_229), USD(7_542)]);
    expect(r.warnings).toEqual(["3 deposits needed (limit 246229000000 per transfer)"]);
  });
  it("merges a dust last chunk into the previous deposit and drops a dust-only return", () => {
    const r = splitReturn(USD(246_229) + 100n, limits);
    expect(r.chunks).toEqual([USD(246_229) + 100n]);
    expect(r.warnings.some((w) => w.includes("exceeds the instant limit"))).toBe(true);
    expect(splitReturn(100n, limits)).toMatchObject({ chunks: [], warnings: [expect.stringMatching(/below Across minDeposit/)] });
    expect(splitReturn(0n, limits)).toMatchObject({ chunks: [] });
  });
  it("falls back to maxDeposit when there is no instant capacity, and warns when there is none at all", () => {
    expect(splitReturn(USD(300_000), baseLimits({ maxDepositInstant: 0n, maxDeposit: USD(200_000) })).chunks).toEqual([USD(200_000), USD(100_000)]);
    expect(splitReturn(USD(300_000), baseLimits({ maxDepositInstant: 0n, maxDeposit: 0n }))).toMatchObject({ chunks: [USD(300_000)], warnings: [expect.stringMatching(/no capacity/)] });
  });
});

describe("planReturn", () => {
  it("quotes each chunk and lists the multisig steps (sub-account → master → spot → HyperEVM → Across)", async () => {
    const across = new FakeAcross();
    across.lim = baseLimits({ maxDepositInstant: USD(246_229), maxDeposit: USD(246_229) });
    const sub = "0x1000000000000000000000000000000000000009";
    const plan = await planReturn(across, 1n, USD(300_000), baseVault(), VAULT, 4663n, { tradingAccount: sub });
    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks[0]).toMatchObject({ index: 1, inputAmount: USD(246_229), outputAmount: USD(246_229) - (USD(246_229) * 6n) / 10_000n, feeBps: 6 });
    expect(plan.route).toEqual(returnRoute(baseVault(), 4663n));
    expect(across.quotes.map((q) => q.amount)).toEqual([USD(246_229), USD(53_771)]);
    expect(plan.steps[0]).toMatch(/subAccountTransfer 300000.00 USDC from 0x1000000000000000000000000000000000000009 to the master/);
    expect(plan.steps[1]).toMatch(/usdClassTransfer/);
    expect(plan.steps[2]).toMatch(/spotSend .* 0x2000000000000000000000000000000000000000/);
    expect(plan.steps[3]).toMatch(/Across SpokePool deposit 246229.00 USDC → USDG on chain 4663, recipient 0x1000000000000000000000000000000000000001/);
    expect(plan.steps.at(-1)).toMatch(/reportClosed\(1\)/);
    expect(plan.alternative[0]).toMatch(/withdraw3/);
    const text = formatReturnPlan(plan);
    expect(text).toContain("RETURN PLAN decision 1: 300000.00 USDC");
    expect(text).toContain("The keeper cannot sign any of these steps");
    expect(text).toContain("2 deposits needed");
  });
  it("skips the sub-account step when trading on the master and tolerates quote failures", async () => {
    const across = new FakeAcross();
    across.suggestedFees = async () => {
      throw new Error("503");
    };
    const plan = await planReturn(across, 2n, USD(1_000), baseVault(), VAULT, 4663n, { tradingAccount: HL_ACCOUNT });
    expect(plan.steps[0]).toMatch(/^1\. HyperCore: usdClassTransfer/);
    expect(plan.chunks[0]?.outputAmount).toBeUndefined();
    expect(plan.warnings.some((w) => w.includes("quote failed"))).toBe(true);
  });
});
