import { getAddress, type Address, type Hex } from "viem";
import type { AcrossApi, RouteParams } from "../src/across/api.js";
import type { ChainReader } from "../src/chain/reader.js";
import type { Config } from "../src/config.js";
import type { CloseResult, ExecResult, Executor, OpenResult, ProtectResult, ReturnInstructionsInput } from "../src/executor.js";
import type { HyperliquidInfo } from "../src/hyperliquid/info.js";
import { Alerts, Logger, type Alert, type AlertSink } from "../src/log.js";
import type { ClosePlan, ConvertPlan, ExecutePlan, OpenPlan, ProtectPlan } from "../src/planner.js";
import type { Run } from "../src/store.js";
import type {
  AcrossDepositStatus,
  AcrossLimits,
  AcrossQuote,
  GovernanceSnapshot,
  HlAccountState,
  HlAgent,
  HlOpenOrder,
  HlOrderStatus,
  PerpMeta,
  VaultSnapshot,
} from "../src/types.js";

export const VAULT = getAddress("0x1000000000000000000000000000000000000001");
export const GOV = getAddress("0x1000000000000000000000000000000000000002");
export const HL_ACCOUNT = getAddress("0x1000000000000000000000000000000000000003");
export const KEEPER = getAddress("0x1000000000000000000000000000000000000004");
export const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
export const USDC_HYPEREVM = getAddress("0xb88339CB7199b77E23DB6E890353E22632Ba630f");
export const SPOKE = getAddress("0xD29C85F15DF544bA632C9E25829fd29d767d7978");

export const NOW = 1_790_000_000; // chain seconds

export const USD = (n: number | string): bigint => BigInt(Math.round(Number(n) * 1e6));

export const UNIVERSE: PerpMeta[] = [
  { index: 0, name: "BTC", szDecimals: 5, maxLeverage: 40, isDelisted: false },
  { index: 1, name: "ETH", szDecimals: 4, maxLeverage: 25, isDelisted: false },
  { index: 2, name: "ATOM", szDecimals: 2, maxLeverage: 5, isDelisted: false },
  { index: 3, name: "MATIC", szDecimals: 1, maxLeverage: 20, isDelisted: true },
  { index: 4, name: "DYDX", szDecimals: 1, maxLeverage: 5, isDelisted: false },
  { index: 5, name: "SOL", szDecimals: 2, maxLeverage: 20, isDelisted: false },
];

export function baseConfig(over: Partial<Config> = {}): Config {
  return {
    mode: "dry-run",
    rpcUrl: "http://localhost",
    chainId: 4663n,
    vault: VAULT,
    governance: GOV,
    quoter: getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"),
    hlNetwork: "testnet",
    hlInfoUrl: "http://hl/info",
    hlExchangeUrl: "http://hl/exchange",
    hlAccount: HL_ACCOUNT,
    hlTradingAccount: HL_ACCOUNT,
    allowedAssets: ["BTC", "ETH", "SOL"],
    entrySlippageBps: 50,
    killSlippageBps: 200,
    triggerLimitBps: 1000,
    deadManMs: 120_000,
    convertSlippageBps: 30,
    minConvertWei: 10n ** 17n,
    acrossApiUrl: "http://across",
    intervalMs: 1000,
    dbPath: ":memory:",
    sizeBufferBps: 9_800,
    actionTtlMs: 60_000,
    agentExpiryWarnMs: 3 * 24 * 3_600_000,
    minFillMarginSec: 1800,
    reportIntervalMs: 6 * 3_600_000,
    returnWaitMs: 24 * 3_600_000,
    returnToleranceBps: 9_500,
    monitorKill: false,
    takeProfitTrigger: true,
    ...over,
  };
}

export function baseVault(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    paused: false,
    keeper: KEEPER,
    ethBalance: 0n,
    usdgBalance: USD(500_000),
    usdgLedger: USD(500_000),
    nav: USD(500_000),
    maxOrderAmount: USD(100_000),
    lastConvertAt: 0,
    convertCooldown: 600,
    maxConvertPerCall: 50n * 10n ** 18n,
    maxBridgeFeeBps: 50,
    maxDecisionAge: 3 * 86_400,
    reportChallengeWindow: 6 * 3600,
    lastExecutedDecisionId: 0n,
    position: { decisionId: 0n, asset: 0, side: "long", capital: 0n, openedAt: 0, depositId: 0n, closeReportedAt: 0 },
    mustClose: false,
    risk: { stopLossBps: 500, leverage: 3, takeProfitBps: 1000 },
    bridgeRecipient: HL_ACCOUNT,
    bridgeOutputToken: USDC_HYPEREVM,
    destinationChainId: 999n,
    usdg: USDG,
    spokePool: SPOKE,
    spokePoolNumberOfDeposits: 373_000n,
    blockTimestamp: NOW,
    blockNumber: 73_600_000n,
    ...over,
  };
}

export function baseGov(over: Partial<GovernanceSnapshot> = {}): GovernanceSnapshot {
  return {
    decision: { id: 1n, asset: 1, side: "long", roundId: 7n, decidedAt: NOW - 3600 },
    round: { endsAt: NOW - 3600, finalized: true },
    closeRequested: false,
    paused: false,
    ...over,
  };
}

export function baseLimits(over: Partial<AcrossLimits> = {}): AcrossLimits {
  return {
    minDeposit: 500_101n,
    maxDeposit: USD(692_352),
    maxDepositInstant: USD(260_818),
    maxDepositShortDelay: USD(692_352),
    recommendedDepositInstant: USD(260_818),
    ...over,
  };
}

export function quoteFor(amount: bigint, now = NOW, feeBps = 6n, over: Partial<AcrossQuote> = {}): AcrossQuote {
  return {
    outputAmount: amount - (amount * feeBps) / 10_000n,
    timestamp: now - 60,
    fillDeadline: now + 7200,
    totalRelayFeePct: feeBps * 10n ** 14n,
    totalRelayFeeTotal: (amount * feeBps) / 10_000n,
    lpFeePct: 0n,
    estimatedFillTimeSec: 98,
    isAmountTooLow: false,
    spokePoolAddress: SPOKE,
    exclusiveRelayer: getAddress("0x0000000000000000000000000000000000000000"),
    exclusivityDeadline: 0,
    limits: baseLimits(),
    ...over,
  };
}

export class FakeChain implements ChainReader {
  v: VaultSnapshot = baseVault();
  g: GovernanceSnapshot = baseGov();
  floor = USD(2600);
  spot = USD(2690);
  executed?: { outputAmount: bigint; depositId: bigint; blockNumber: bigint };
  async vault() {
    return structuredClone(this.v);
  }
  async governance() {
    return structuredClone(this.g);
  }
  async quoteEthToUsdg(amountIn: bigint) {
    return (this.spot * amountIn) / 10n ** 18n;
  }
  async twapFloor(amountIn: bigint) {
    return (this.floor * amountIn) / 10n ** 18n;
  }
  async orderExecuted() {
    return this.executed;
  }
}

export class FakeHl implements HyperliquidInfo {
  universe = UNIVERSE;
  mids: Record<string, string> = { BTC: "84295.5", ETH: "2692.85", SOL: "120.145" };
  state: HlAccountState = { accountValue: "0", totalMarginUsed: "0", withdrawable: "0", positions: [] };
  orders: HlOpenOrder[] = [];
  agents: HlAgent[] = [];
  statuses = new Map<string, HlOrderStatus>();
  calls: string[] = [];
  async meta() {
    this.calls.push("meta");
    return this.universe;
  }
  async allMids() {
    this.calls.push("allMids");
    return { ...this.mids };
  }
  async clearinghouseState() {
    this.calls.push("clearinghouseState");
    return structuredClone(this.state);
  }
  async frontendOpenOrders() {
    this.calls.push("frontendOpenOrders");
    return structuredClone(this.orders);
  }
  async extraAgents() {
    return this.agents;
  }
  async orderStatus(_u: Address, oid: number | Hex) {
    return this.statuses.get(String(oid)) ?? { status: "unknownOid" as const };
  }
}

export class FakeAcross implements AcrossApi {
  lim = baseLimits();
  feeBps = 6n;
  status: AcrossDepositStatus = { status: "pending" };
  now = NOW;
  spoke: Address = SPOKE;
  quotes: { route: RouteParams; amount: bigint }[] = [];
  async limits() {
    return this.lim;
  }
  async suggestedFees(route: RouteParams, amount: bigint) {
    this.quotes.push({ route, amount });
    return quoteFor(amount, this.now, this.feeBps, { limits: this.lim, spokePoolAddress: this.spoke });
  }
  async depositStatus() {
    return this.status;
  }
}

/** Records every call; results are scripted per method (default: done, success). */
export class ScriptedExecutor implements Executor {
  calls: { method: string; args: unknown[] }[] = [];
  results: Partial<{
    convert: ExecResult;
    executeDecision: ExecResult & { depositId?: bigint };
    open: OpenResult;
    protect: ProtectResult;
    close: CloseResult;
    killSwitch: CloseResult;
    reportPosition: ExecResult;
    returnInstructions: ExecResult;
    reportClosed: ExecResult;
    finalizeClose: ExecResult;
    reconcile: ExecResult;
  }> = {};
  private rec<T extends ExecResult>(method: keyof ScriptedExecutor["results"], args: unknown[], dflt: T): T {
    this.calls.push({ method, args });
    return (this.results[method] as T | undefined) ?? dflt;
  }
  async convert(plan: ConvertPlan) {
    return this.rec("convert", [plan], { done: true, txHash: "0x01" as Hex });
  }
  async executeDecision(plan: ExecutePlan) {
    return this.rec("executeDecision", [plan], { done: true, txHash: "0x02" as Hex, depositId: plan.expectedDepositId });
  }
  async open(plan: OpenPlan, run: Run) {
    return this.rec<OpenResult>("open", [plan, run], { done: true, filledSize: plan.size, avgPx: plan.mid, oids: [1], attempts: 1 });
  }
  async protect(plan: ProtectPlan, run: Run) {
    return this.rec<ProtectResult>("protect", [plan, run], { done: true, verified: true, stopLossOid: 2, takeProfitOid: 3 });
  }
  async close(plan: ClosePlan, run: Run) {
    return this.rec<CloseResult>("close", [plan, run], { done: true, flat: true });
  }
  async killSwitch(reason: string) {
    return this.rec<CloseResult>("killSwitch", [reason], { done: true, flat: true });
  }
  async reportPosition(decisionId: bigint, equity: bigint) {
    return this.rec("reportPosition", [decisionId, equity], { done: true, txHash: "0x03" as Hex });
  }
  async returnInstructions(input: ReturnInstructionsInput) {
    return this.rec("returnInstructions", [input], { done: true });
  }
  async reportClosed(decisionId: bigint) {
    return this.rec("reportClosed", [decisionId], { done: true, txHash: "0x04" as Hex });
  }
  async finalizeClose(decisionId: bigint) {
    return this.rec("finalizeClose", [decisionId], { done: true, txHash: "0x05" as Hex });
  }
  async reconcile(stray: bigint) {
    return this.rec("reconcile", [stray], { done: true, txHash: "0x06" as Hex });
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

export class MemorySink implements AlertSink {
  alerts: Alert[] = [];
  async send(a: Alert) {
    this.alerts.push(a);
  }
}

export function memoryAlerts(): { alerts: Alerts; sink: MemorySink } {
  const sink = new MemorySink();
  return { alerts: new Alerts([sink]), sink };
}

export const silentLogger = () => new Logger("test", "error");
