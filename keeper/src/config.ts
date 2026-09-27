import { getAddress, isHex, type Address, type Hex } from "viem";

/**
 * Keeper run mode.
 * - `dry-run`: reads everything, computes and logs every planned action, never signs, never sends anything.
 * - `live`: signs vault transactions with `KEEPER_PRIVATE_KEY` and Hyperliquid L1 actions with `HL_AGENT_PRIVATE_KEY`.
 *   Refused on Robinhood mainnet (4663) unless `ALLOW_MAINNET=1` is set explicitly.
 */
export type Mode = "dry-run" | "live";

export type HlNetwork = "mainnet" | "testnet";

export interface Config {
  mode: Mode;
  /** Robinhood Chain JSON-RPC. */
  rpcUrl: string;
  chainId: bigint;
  vault: Address;
  governance: Address;
  /** Uniswap v3 QuoterV2 used for the ETH→USDG spot quote (read-only). */
  quoter: Address;
  /** Only in live mode: the vault's `keeper` EOA. Can only call the bounded keeper functions. */
  keeperKey?: Hex;
  /** Only in live mode: the Hyperliquid AGENT key. Trading only; it cannot sign any user-signed action. */
  hlAgentKey?: Hex;
  hlNetwork: HlNetwork;
  hlInfoUrl: string;
  hlExchangeUrl: string;
  /** Hyperliquid master account (multisig, D4) = the vault's immutable `bridgeRecipient`. */
  hlAccount: Address;
  /** Account actually traded: a sub-account of the master (D4) or the master itself. */
  hlTradingAccount: Address;
  /** Closed list of perp names the keeper may ever trade; a decision outside it is refused (fail-closed). */
  allowedAssets: string[];
  /** Max distance from the mid price accepted for an IOC entry/exit, in bps. */
  entrySlippageBps: number;
  /** Slippage bound of the kill switch / emergency flatten, in bps. */
  killSlippageBps: number;
  /** Limit price room of a triggered market stop/TP below/above its trigger, in bps. */
  triggerLimitBps: number;
  /** Dead-man switch delay armed around the entry order, ms. */
  deadManMs: number;
  /** Extra discount below the on-chain TWAP floor the keeper is willing to accept on a conversion, in bps. */
  convertSlippageBps: number;
  /** Below this ETH balance (wei) the keeper does not bother converting. */
  minConvertWei: bigint;
  /** Across public API base. */
  acrossApiUrl: string;
  /** Loop period, ms. */
  intervalMs: number;
  dbPath: string;
  alertWebhookUrl?: string;
  /** Position size is never more than this share of the theoretical capital × leverage (bps, ≤ 10 000). */
  sizeBufferBps: number;
  /** Ms before a signed Hyperliquid action expires if the API has not processed it. */
  actionTtlMs: number;
  /** Agent expiry alert threshold, ms. */
  agentExpiryWarnMs: number;
  /** Minimum time before the Across fill deadline the keeper requires when it sends `executeDecision`. */
  minFillMarginSec: number;
  /** Mark-to-market `reportPosition` every this many ms while a position is open. */
  reportIntervalMs: number;
  /** After this long waiting for the multisig to send funds back, escalate (ms). */
  returnWaitMs: number;
  /** Fraction of the expected return (bps) that must have arrived before `reportClosed` is sent. */
  returnToleranceBps: number;
  /** Guardian-visible override: report the close of this decision id even if less than expected came back. */
  forceReportClosedId?: bigint;
  /** Independent monitor: when true, a red finding triggers the kill switch instead of an alert only. */
  monitorKill: boolean;
  /**
   * Place a take-profit trigger at `takeProfitBps` of capital (default). When false the keeper only reports equity
   * and lets governance vote the close (`closeVoteAllowed`).
   */
  takeProfitTrigger: boolean;
}

const req = (env: NodeJS.ProcessEnv, k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const hexKey = (env: NodeJS.ProcessEnv, k: string): Hex | undefined => {
  const v = env[k];
  if (v === undefined || v === "") return undefined;
  if (!isHex(v) || v.length !== 66) throw new Error(`${k} must be a 32-byte hex private key`);
  return v;
};

const bps = (env: NodeJS.ProcessEnv, k: string, dflt: number, max = 10_000): number => {
  const v = env[k] === undefined ? dflt : Number(env[k]);
  if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${k} must be an integer in [0, ${max}]`);
  return v;
};

export const ROBINHOOD_MAINNET = 4663n;
export const HL_MAINNET_INFO = "https://api.hyperliquid.xyz/info";
export const HL_MAINNET_EXCHANGE = "https://api.hyperliquid.xyz/exchange";
export const HL_TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";
export const HL_TESTNET_EXCHANGE = "https://api.hyperliquid-testnet.xyz/exchange";
/** Uniswap v3 QuoterV2 on Robinhood Chain (RESEARCH.md §3.3). */
export const QUOTER_V2 = getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode: Mode = env.MODE === "live" ? "live" : "dry-run";
  const chainId = BigInt(env.CHAIN_ID ?? "4663");
  if (mode === "live" && chainId === ROBINHOOD_MAINNET && env.ALLOW_MAINNET !== "1") {
    throw new Error("live mode on Robinhood mainnet requires ALLOW_MAINNET=1");
  }
  const hlNetwork: HlNetwork = env.HL_NETWORK === "testnet" ? "testnet" : "mainnet";
  const keeperKey = hexKey(env, "KEEPER_PRIVATE_KEY");
  const hlAgentKey = hexKey(env, "HL_AGENT_PRIVATE_KEY");
  if (mode === "live" && (!keeperKey || !hlAgentKey)) {
    throw new Error("live mode requires KEEPER_PRIVATE_KEY and HL_AGENT_PRIVATE_KEY");
  }
  const hlAccount = getAddress(req(env, "HL_ACCOUNT"));
  const allowedAssets = (env.ALLOWED_ASSETS ?? "BTC,ETH,SOL")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedAssets.length === 0) throw new Error("ALLOWED_ASSETS must not be empty");
  return {
    mode,
    rpcUrl: env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
    chainId,
    vault: getAddress(req(env, "VAULT")),
    governance: getAddress(req(env, "GOVERNANCE")),
    quoter: env.QUOTER ? getAddress(env.QUOTER) : QUOTER_V2,
    keeperKey,
    hlAgentKey,
    hlNetwork,
    hlInfoUrl: env.HL_INFO_URL ?? (hlNetwork === "mainnet" ? HL_MAINNET_INFO : HL_TESTNET_INFO),
    hlExchangeUrl: env.HL_EXCHANGE_URL ?? (hlNetwork === "mainnet" ? HL_MAINNET_EXCHANGE : HL_TESTNET_EXCHANGE),
    hlAccount,
    hlTradingAccount: env.HL_TRADING_ACCOUNT ? getAddress(env.HL_TRADING_ACCOUNT) : hlAccount,
    allowedAssets,
    entrySlippageBps: bps(env, "ENTRY_SLIPPAGE_BPS", 50, 500),
    killSlippageBps: bps(env, "KILL_SLIPPAGE_BPS", 200, 2000),
    triggerLimitBps: bps(env, "TRIGGER_LIMIT_BPS", 1000, 3000),
    deadManMs: Number(env.DEADMAN_MS ?? "120000"),
    convertSlippageBps: bps(env, "CONVERT_SLIPPAGE_BPS", 30, 1000),
    minConvertWei: BigInt(env.MIN_CONVERT_WEI ?? "100000000000000000"),
    acrossApiUrl: env.ACROSS_API_URL ?? "https://app.across.to/api",
    intervalMs: Number(env.INTERVAL_MS ?? "15000"),
    dbPath: env.DB_PATH ?? "data/keeper.sqlite",
    alertWebhookUrl: env.ALERT_WEBHOOK_URL,
    sizeBufferBps: bps(env, "SIZE_BUFFER_BPS", 9_800),
    actionTtlMs: Number(env.ACTION_TTL_MS ?? "60000"),
    agentExpiryWarnMs: Number(env.AGENT_EXPIRY_WARN_MS ?? String(3 * 24 * 3600 * 1000)),
    minFillMarginSec: Number(env.MIN_FILL_MARGIN_SEC ?? "1800"),
    reportIntervalMs: Number(env.REPORT_INTERVAL_MS ?? String(6 * 3600 * 1000)),
    returnWaitMs: Number(env.RETURN_WAIT_MS ?? String(24 * 3600 * 1000)),
    returnToleranceBps: bps(env, "RETURN_TOLERANCE_BPS", 9_500),
    forceReportClosedId: env.FORCE_REPORT_CLOSED_ID ? BigInt(env.FORCE_REPORT_CLOSED_ID) : undefined,
    monitorKill: env.MONITOR_KILL === "1",
    takeProfitTrigger: env.TAKE_PROFIT_TRIGGER !== "0",
  };
}
