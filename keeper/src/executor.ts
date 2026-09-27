import type { Hex } from "viem";
import { Logger } from "./log.js";
import type { ClosePlan, ConvertPlan, ExecutePlan, OpenPlan, ProtectPlan } from "./planner.js";
import type { Run } from "./store.js";

/** Result of an executor call. `done = false` means nothing happened (dry-run) or the step must be retried. */
export interface ExecResult {
  done: boolean;
  txHash?: Hex;
  note?: string;
}

export interface OpenResult extends ExecResult {
  /** Absolute size filled so far, decimal string. */
  filledSize?: string;
  avgPx?: string;
  oids?: number[];
  attempts?: number;
}

export interface ProtectResult extends ExecResult {
  stopLossOid?: number;
  takeProfitOid?: number;
  /** True when the stop was read back from `frontendOpenOrders` (fail-closed otherwise). */
  verified?: boolean;
}

export interface CloseResult extends ExecResult {
  /** True when the account has no position left on the coin. */
  flat?: boolean;
}

export interface ReturnInstructionsInput {
  decisionId: bigint;
  /** USDC equity on the trading account, 6 decimals. */
  equity: bigint;
  coin: string;
}

/**
 * Side effects of the keeper. The dry-run implementation logs; live implementations (S5.2 Hyperliquid, S5.3 bridge,
 * S5.4 reporting) sign with the bounded keys. The keeper loop is the same in both cases.
 */
export interface Executor {
  convert(plan: ConvertPlan): Promise<ExecResult>;
  executeDecision(plan: ExecutePlan): Promise<ExecResult & { depositId?: bigint }>;
  open(plan: OpenPlan, run: Run): Promise<OpenResult>;
  protect(plan: ProtectPlan, run: Run): Promise<ProtectResult>;
  close(plan: ClosePlan, run: Run): Promise<CloseResult>;
  /** Cancel everything and flatten every position on the trading account. */
  killSwitch(reason: string): Promise<CloseResult>;
  reportPosition(decisionId: bigint, equity: bigint): Promise<ExecResult>;
  /** Prepares (never signs) the payload the HL multisig must sign to bring the funds back. */
  returnInstructions(input: ReturnInstructionsInput): Promise<ExecResult>;
  reportClosed(decisionId: bigint): Promise<ExecResult>;
  finalizeClose(decisionId: bigint): Promise<ExecResult>;
  reconcile(stray: bigint): Promise<ExecResult>;
}

/** Logs every planned action and does nothing. Stages never advance, so each tick re-plans from live state. */
export class DryRunExecutor implements Executor {
  readonly planned: { action: string; plan: unknown }[] = [];
  constructor(private readonly log = new Logger("dry-run")) {}

  private would<T extends ExecResult>(action: string, plan: unknown, extra: Partial<T> = {}): T {
    this.planned.push({ action, plan });
    if (this.planned.length > 500) this.planned.shift();
    this.log.info(`WOULD ${action}`, plan as Record<string, unknown>);
    return { done: false, note: "dry-run", ...extra } as T;
  }

  async convert(plan: ConvertPlan) {
    return this.would("convertEthToUsdg", plan);
  }
  async executeDecision(plan: ExecutePlan) {
    return this.would("executeDecision", plan);
  }
  async open(plan: OpenPlan) {
    return this.would<OpenResult>("openPosition (updateLeverage isolated + IOC order)", plan);
  }
  async protect(plan: ProtectPlan) {
    return this.would<ProtectResult>("protect (stop-loss / take-profit triggers + read-back)", plan, { verified: false });
  }
  async close(plan: ClosePlan) {
    return this.would<CloseResult>("closePosition (cancel all + reduce-only IOC)", plan, { flat: false });
  }
  async killSwitch(reason: string) {
    return this.would<CloseResult>("KILL SWITCH (cancel all + reduce-only close)", { reason }, { flat: false });
  }
  async reportPosition(decisionId: bigint, equity: bigint) {
    return this.would("reportPosition", { decisionId, equity });
  }
  async returnInstructions(input: ReturnInstructionsInput) {
    return this.would("returnInstructions (for the HL multisig; never signed by the keeper)", input);
  }
  async reportClosed(decisionId: bigint) {
    return this.would("reportClosed", { decisionId });
  }
  async finalizeClose(decisionId: bigint) {
    return this.would("finalizeClose", { decisionId });
  }
  async reconcile(stray: bigint) {
    return this.would("reconcile", { stray });
  }
}
