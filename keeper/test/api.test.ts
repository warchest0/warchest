import { describe, expect, it } from "vitest";
import { HttpAcrossApi, HYPEREVM_CHAIN_ID, USDC_HYPEREVM, USDG_ROBINHOOD } from "../src/across/api.js";
import { HttpHyperliquidInfo, perpByIndex } from "../src/hyperliquid/info.js";
import { HL_ACCOUNT, UNIVERSE } from "./fakes.js";

const fakeFetch = (handler: (url: string, body?: unknown) => { status?: number; body: unknown }) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const r = handler(url, body);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;

describe("HttpAcrossApi", () => {
  const route = { inputToken: USDG_ROBINHOOD, outputToken: USDC_HYPEREVM, originChainId: 4663n, destinationChainId: HYPEREVM_CHAIN_ID };
  it("parses /limits and /suggested-fees (real response shapes of 2026-09-27)", async () => {
    const api = new HttpAcrossApi(
      "http://across",
      fakeFetch((url) => {
        if (url.startsWith("http://across/limits?")) {
          expect(url).toContain("originChainId=4663");
          return { body: { minDeposit: "500101", maxDeposit: "692352336352", maxDepositInstant: "260818629832", maxDepositShortDelay: "692352336352", recommendedDepositInstant: "260818629832" } };
        }
        expect(url).toContain("amount=100000000000");
        expect(url).toContain(`recipient=${HL_ACCOUNT}`);
        return {
          body: {
            estimatedFillTimeSec: 98,
            timestamp: "1790481563",
            isAmountTooLow: false,
            spokePoolAddress: "0xD29C85F15DF544bA632C9E25829fd29d767d7978",
            exclusiveRelayer: "0x0000000000000000000000000000000000000000",
            exclusivityDeadline: 0,
            totalRelayFee: { pct: "600016400000000", total: "59996639" },
            lpFee: { pct: "0", total: "0" },
            limits: { minDeposit: "500101", maxDeposit: "692352336352", maxDepositInstant: "260818629832", maxDepositShortDelay: "692352336352", recommendedDepositInstant: "260818629832" },
            fillDeadline: "1790488763",
            outputAmount: "99940003361",
          },
        };
      }),
    );
    const l = await api.limits(route);
    expect(l.maxDepositInstant).toBe(260_818_629_832n);
    const q = await api.suggestedFees(route, 100_000_000_000n, HL_ACCOUNT);
    expect(q).toMatchObject({ outputAmount: 99_940_003_361n, timestamp: 1790481563, fillDeadline: 1790488763, totalRelayFeePct: 600_016_400_000_000n, estimatedFillTimeSec: 98 });
  });
  it("maps deposit statuses, 404 = unknown, other errors throw", async () => {
    const api = new HttpAcrossApi(
      "http://across",
      fakeFetch((url) => {
        if (url.includes("depositId=1")) return { body: { status: "filled", fillTx: "0xabc", depositRefundTxHash: null } };
        if (url.includes("depositId=2")) return { body: { status: "pending" } };
        if (url.includes("depositId=3")) return { body: { status: "refunded", depositRefundTxHash: "0xdef" } };
        if (url.includes("depositId=4")) return { body: { status: "expired" } };
        if (url.includes("depositId=5")) return { status: 404, body: { error: "DepositNotFoundException" } };
        if (url.includes("depositId=6")) return { body: { status: "weird" } };
        return { status: 500, body: "boom" };
      }),
    );
    expect(await api.depositStatus(4663n, 1n)).toEqual({ status: "filled", fillTxHash: "0xabc", fillTimestamp: undefined });
    expect(await api.depositStatus(4663n, 2n)).toEqual({ status: "pending" });
    expect(await api.depositStatus(4663n, 3n)).toEqual({ status: "refunded", refundTxHash: "0xdef" });
    expect(await api.depositStatus(4663n, 4n)).toEqual({ status: "expired" });
    expect(await api.depositStatus(4663n, 5n)).toMatchObject({ status: "unknown" });
    expect(await api.depositStatus(4663n, 6n)).toMatchObject({ status: "unknown" });
    await expect(api.depositStatus(4663n, 7n)).rejects.toThrow(/500/);
  });
});

describe("HttpHyperliquidInfo", () => {
  it("parses meta, clearinghouseState and orderStatus; caches meta", async () => {
    let metaCalls = 0;
    const info = new HttpHyperliquidInfo(
      "http://hl/info",
      fakeFetch((_url, body) => {
        const b = body as { type: string; user?: string; oid?: unknown };
        switch (b.type) {
          case "meta":
            metaCalls++;
            return { body: { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "MATIC", szDecimals: 1, maxLeverage: 20, isDelisted: true }] } };
          case "clearinghouseState":
            return {
              body: {
                marginSummary: { accountValue: "1000.5", totalMarginUsed: "300" },
                withdrawable: "700.5",
                assetPositions: [{ type: "oneWay", position: { coin: "BTC", szi: "-0.01", leverage: { type: "isolated", value: 3 }, entryPx: "84000", positionValue: "840", unrealizedPnl: "1", liquidationPx: null, marginUsed: "280" } }],
              },
            };
          case "orderStatus":
            return b.oid === 7 ? { body: { status: "order", order: { order: { coin: "BTC", oid: 7 }, status: "filled", statusTimestamp: 1 } } } : { body: { status: "unknownOid" } };
          default:
            return { status: 500, body: "nope" };
        }
      }),
    );
    const u = await info.meta();
    await info.meta();
    expect(metaCalls).toBe(1);
    expect(u[1]).toMatchObject({ index: 1, name: "MATIC", isDelisted: true });
    expect(() => perpByIndex(u, 1)).toThrow(/delisted/);
    expect(() => perpByIndex(u, 9)).toThrow(/unknown/);
    expect(perpByIndex(UNIVERSE, 5).name).toBe("SOL");
    const s = await info.clearinghouseState(HL_ACCOUNT);
    expect(s).toMatchObject({ accountValue: "1000.5", withdrawable: "700.5" });
    expect(s.positions[0]).toMatchObject({ coin: "BTC", szi: "-0.01", leverageType: "isolated", leverage: 3, liquidationPx: undefined });
    expect(await info.orderStatus(HL_ACCOUNT, 7)).toMatchObject({ status: "order", state: "filled" });
    expect(await info.orderStatus(HL_ACCOUNT, 8)).toEqual({ status: "unknownOid" });
    await expect(info.allMids()).rejects.toThrow(/HTTP 500/);
  });
});
