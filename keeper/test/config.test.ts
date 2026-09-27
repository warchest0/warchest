import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { GOV, HL_ACCOUNT, VAULT } from "./fakes.js";

const base = { VAULT, GOVERNANCE: GOV, HL_ACCOUNT };
const KEY = `0x${"11".repeat(32)}`;

describe("loadConfig", () => {
  it("defaults to dry-run on mainnet with the mainnet Hyperliquid endpoints", () => {
    const c = loadConfig(base);
    expect(c.mode).toBe("dry-run");
    expect(c.chainId).toBe(4663n);
    expect(c.hlInfoUrl).toBe("https://api.hyperliquid.xyz/info");
    expect(c.hlTradingAccount).toBe(HL_ACCOUNT);
    expect(c.allowedAssets).toEqual(["BTC", "ETH", "SOL"]);
    expect(c.takeProfitTrigger).toBe(true);
  });
  it("refuses live mode on mainnet without ALLOW_MAINNET=1 and without both keys", () => {
    expect(() => loadConfig({ ...base, MODE: "live" })).toThrow(/ALLOW_MAINNET/);
    expect(() => loadConfig({ ...base, MODE: "live", CHAIN_ID: "46630" })).toThrow(/requires KEEPER_PRIVATE_KEY/);
    expect(() => loadConfig({ ...base, MODE: "live", CHAIN_ID: "46630", KEEPER_PRIVATE_KEY: KEY })).toThrow(/HL_AGENT_PRIVATE_KEY/);
    const c = loadConfig({ ...base, MODE: "live", CHAIN_ID: "46630", KEEPER_PRIVATE_KEY: KEY, HL_AGENT_PRIVATE_KEY: KEY, HL_NETWORK: "testnet" });
    expect(c.mode).toBe("live");
    expect(c.hlExchangeUrl).toBe("https://api.hyperliquid-testnet.xyz/exchange");
  });
  it("validates keys, bps and required addresses", () => {
    expect(() => loadConfig({ ...base, KEEPER_PRIVATE_KEY: "0x12" })).toThrow(/32-byte/);
    expect(() => loadConfig({ ...base, ENTRY_SLIPPAGE_BPS: "9999" })).toThrow(/ENTRY_SLIPPAGE_BPS/);
    expect(() => loadConfig({ VAULT, GOVERNANCE: GOV })).toThrow(/HL_ACCOUNT/);
    expect(() => loadConfig({ ...base, ALLOWED_ASSETS: " , " })).toThrow(/ALLOWED_ASSETS/);
  });
});
