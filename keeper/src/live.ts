/**
 * Live executor: vault transactions through {@link ChainWriter} (keeper key), Hyperliquid through
 * {@link TradingEngine} (agent key), and the return leg as a PLAN for the multisig (never signed here).
 */
import type { Address } from "viem";
import type { AcrossApi } from "./across/api.js";
import { formatReturnPlan, planReturn } from "./across/bridge.js";
import type { ChainWriter } from "./chain/writer.js";
import type { ChainReader } from "./chain/reader.js";
import type { CloseResult, ExecResult, Executor, OpenResult, ProtectResult, ReturnInstructionsInput } from "./executor.js";
import type { TradingEngine } from "./hyperliquid/engine.js";
import { Alerts, Logger } from "./log.js";
import type { ClosePlan, ConvertPlan, ExecutePlan, OpenPlan, ProtectPlan } from "./planner.js";
import type { Run } from "./store.js";

export interface LiveDeps {
  writer: ChainWriter;
  reader: ChainReader;
  engine: TradingEngine;
  across: AcrossApi;
  alerts: Alerts;
  vault: Address;
  chainId: bigint;
  tradingAccount: Address;
  log?: Logger;
}

export class LiveExecutor implements Executor {
  private readonly log: Logger;
  /** Last return plan issued (also persisted by the keeper through the alert/event trail). */
  lastReturnPlan?: string;

  constructor(private readonly d: LiveDeps) {
    this.log = d.log ?? new Logger("live");
  }

  async convert(plan: ConvertPlan): Promise<ExecResult> {
    const r = await this.d.writer.convertEthToUsdg(plan.amountIn, plan.minOut);
    this.log.info(`converted ${plan.amountIn} wei → ${r.amountOut ?? "?"} USDG`, { txHash: r.txHash });
    return { done: true, txHash: r.txHash };
  }

  async executeDecision(plan: ExecutePlan) {
    const r = await this.d.writer.executeDecision(plan.amount, plan.outputAmount, plan.quoteTimestamp, plan.fillDeadline);
    if (r.depositId === undefined) await this.d.alerts.warning("executeDecision mined but OrderExecuted not decoded", { txHash: r.txHash });
    return { done: true, txHash: r.txHash, depositId: r.depositId };
  }

  open(plan: OpenPlan, run: Run): Promise<OpenResult> {
    return this.d.engine.open(plan, run);
  }
  protect(plan: ProtectPlan, run: Run): Promise<ProtectResult> {
    return this.d.engine.protect(plan, run);
  }
  close(plan: ClosePlan, run: Run): Promise<CloseResult> {
    return this.d.engine.close(plan, run);
  }
  killSwitch(reason: string): Promise<CloseResult> {
    return this.d.engine.killSwitch(reason);
  }

  async reportPosition(decisionId: bigint, equity: bigint): Promise<ExecResult> {
    const r = await this.d.writer.reportPosition(decisionId, equity);
    return { done: true, txHash: r.txHash };
  }

  async returnInstructions(input: ReturnInstructionsInput): Promise<ExecResult> {
    const vault = await this.d.reader.vault();
    const plan = await planReturn(this.d.across, input.decisionId, input.equity, vault, this.d.vault, this.d.chainId, { tradingAccount: this.d.tradingAccount });
    const text = formatReturnPlan(plan);
    this.lastReturnPlan = text;
    this.log.info(`\n${text}`);
    await this.d.alerts.critical("RETURN REQUIRED: multisig must bring the funds back", { decisionId: input.decisionId, total: input.equity, chunks: plan.chunks.length, plan: text });
    return { done: true, note: text };
  }

  async reportClosed(decisionId: bigint): Promise<ExecResult> {
    const r = await this.d.writer.reportClosed(decisionId);
    return { done: true, txHash: r.txHash };
  }
  async finalizeClose(decisionId: bigint): Promise<ExecResult> {
    const r = await this.d.writer.finalizeClose(decisionId);
    return { done: true, txHash: r.txHash };
  }
  async reconcile(): Promise<ExecResult> {
    const r = await this.d.writer.reconcile();
    return { done: true, txHash: r.txHash };
  }
}
