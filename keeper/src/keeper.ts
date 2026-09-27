/**
 * The keeper loop: one `tick()` reads the vault, governance, Hyperliquid and Across, decides what the current
 * decision requires, and hands the bounded action to the {@link Executor}. Every stage is re-derived from observed
 * state, so a crash/restart at any point is safe: nothing is ever done twice, and nothing is done on stale data.
 */
import type { Address } from "viem";
import type { AcrossApi } from "./across/api.js";
import type { ChainReader } from "./chain/reader.js";
import type { Config } from "./config.js";
import type { Executor } from "./executor.js";
import type { HyperliquidInfo } from "./hyperliquid/info.js";
import { perpByIndex } from "./hyperliquid/info.js";
import { cmpDecimals, decimalToUsd6, usd6ToDecimal } from "./hyperliquid/rounding.js";
import { Alerts, Logger } from "./log.js";
import {
  bridgeAmount,
  convertAmount,
  decisionExecutable,
  formatUsd6,
  isRefusal,
  isWait,
  planClose,
  planConvert,
  planExecute,
  planOpen,
  planProtect,
  BPS,
} from "./planner.js";
import type { Run, Stage, Store } from "./store.js";
import type { GovernanceSnapshot, HlAccountState, HlPosition, PerpMeta, VaultSnapshot } from "./types.js";

export interface KeeperDeps {
  cfg: Config;
  chain: ChainReader;
  hl: HyperliquidInfo;
  across: AcrossApi;
  exec: Executor;
  store: Store;
  alerts: Alerts;
  log?: Logger;
  /** Address of the keeper EOA (live mode); undefined in dry-run. */
  keeperAddress?: Address;
  /** Address of the Hyperliquid agent (live mode) for expiry checks. */
  agentAddress?: Address;
  now?: () => number;
}

export interface TickReport {
  phase: string;
  decisionId: bigint;
  stage?: Stage;
  /** Human-readable summary lines of what was decided. */
  lines: string[];
  vault: VaultSnapshot;
  gov: GovernanceSnapshot;
}

/** Minimum accepted USDC on the trading account vs the bridged output (bps): tolerates the HyperEVM→HyperCore dust. */
const FUNDING_TOLERANCE_BPS = 9_900n;
const MAX_ENTRY_ATTEMPTS = 5;

export class Keeper {
  private readonly log: Logger;
  private readonly now: () => number;
  private fundingInstructionsIssued = new Set<string>();

  constructor(private readonly d: KeeperDeps) {
    this.log = d.log ?? new Logger("keeper");
    this.now = d.now ?? (() => Date.now());
  }

  /** Chain time is the reference for every vault bound (seconds). */
  async tick(): Promise<TickReport> {
    const { cfg, chain, hl, store } = this.d;
    const [vault, gov, universe] = await Promise.all([chain.vault(), chain.governance(), hl.meta()]);
    const now = vault.blockTimestamp;
    const lines: string[] = [];
    const say = (s: string) => {
      lines.push(s);
      this.log.info(s);
    };

    say(`vault ${cfg.vault} block ${vault.blockNumber} paused=${vault.paused} nav=${formatUsd6(vault.nav)} ledger=${formatUsd6(vault.usdgLedger)} eth=${vault.ethBalance} position=${vault.position.decisionId} mustClose=${vault.mustClose}`);
    say(`governance decision id=${gov.decision.id} asset=${gov.decision.asset} side=${gov.decision.side} round=${gov.decision.roundId} closeRequested=${gov.closeRequested} paused=${gov.paused}`);

    if (this.d.keeperAddress && vault.keeper.toLowerCase() !== this.d.keeperAddress.toLowerCase()) {
      await this.d.alerts.critical("keeper key is not the vault keeper", { vaultKeeper: vault.keeper, ours: this.d.keeperAddress });
      return { phase: "misconfigured", decisionId: 0n, lines, vault, gov };
    }
    await this.checkAgentExpiry();

    // ---- position closing on-chain: only the permissionless finalize is left
    if (vault.position.decisionId !== 0n && vault.position.closeReportedAt !== 0) {
      const id = vault.position.decisionId;
      const finalAt = vault.position.closeReportedAt + vault.reportChallengeWindow;
      if (now < finalAt) {
        say(`decision ${id}: close reported, challenge window open until ${finalAt} (${finalAt - now}s left)`);
        return { phase: "await_finalize", decisionId: id, stage: "report_closed", lines, vault, gov };
      }
      say(`decision ${id}: challenge window over, finalizeClose`);
      const r = await this.d.exec.finalizeClose(id);
      if (r.done && store.getRun(id)) store.transition(id, "finalized", { finalizeTxHash: r.txHash });
      return { phase: "finalize", decisionId: id, stage: "finalized", lines, vault, gov };
    }

    // ---- no position: idle duties (reconcile, convert, execute)
    if (vault.position.decisionId === 0n) {
      const stray = vault.usdgBalance - vault.usdgLedger;
      if (stray > 0n) {
        say(`stray USDG ${formatUsd6(stray)} on the vault: reconcile`);
        await this.d.exec.reconcile(stray);
      }
      await this.maybeConvert(vault, now, say);
      const phase = await this.maybeExecute(vault, gov, universe, now, say);
      return { phase, decisionId: gov.decision.id, lines, vault, gov };
    }

    // ---- open position: run the lifecycle
    const id = vault.position.decisionId;
    const perp = perpByIndex(universe, vault.position.asset);
    if (!cfg.allowedAssets.includes(perp.name)) {
      await this.d.alerts.critical("vault position on an asset outside the keeper allowlist", { asset: perp.name });
      // fail-closed: never trade it, but keep the lifecycle so the funds come back
    }
    let run = store.getRun(id) ?? (await this.adopt(vault, perp, say));
    const state = await hl.clearinghouseState(cfg.hlTradingAccount);
    const hlPos = state.positions.find((p) => p.coin === perp.name);
    const foreign = state.positions.filter((p) => p.coin !== perp.name);
    if (foreign.length > 0) {
      await this.d.alerts.critical("unexpected positions on the trading account", { coins: foreign.map((p) => p.coin) });
    }
    say(`decision ${id} ${perp.name} ${vault.position.side} capital=${formatUsd6(vault.position.capital)} stage=${run.stage} hl: equity=${state.accountValue} withdrawable=${state.withdrawable} position=${hlPos?.szi ?? "none"}`);

    if (vault.mustClose && !["closing", "closed_on_hl", "awaiting_return", "report_closed", "finalized"].includes(run.stage)) {
      say(`decision ${id}: mustClose (paused=${vault.paused} closeRequested=${gov.closeRequested} superseded=${gov.decision.id > id})`);
      if (hlPos) run = store.transition(id, "closing", { closeReason: vault.paused ? "vault paused" : gov.closeRequested ? "close voted" : "decision superseded" });
      else if (run.stage !== "bridging") run = store.transition(id, "closed_on_hl", { closeReason: "mustClose before any position was opened", closedOnHlAt: this.now() });
    }

    run = await this.step(run, vault, gov, perp, state, hlPos, now, say);
    return { phase: run.stage, decisionId: id, stage: run.stage, lines, vault, gov };
  }

  // -----------------------------------------------------------------------------------------------------------------

  private async maybeConvert(vault: VaultSnapshot, now: number, say: (s: string) => void): Promise<void> {
    const amount = convertAmount(vault, this.d.cfg.minConvertWei);
    if (amount === 0n) return;
    const [floor, spot] = await Promise.all([this.d.chain.twapFloor(amount), this.d.chain.quoteEthToUsdg(amount)]);
    const plan = planConvert(vault, floor, spot, this.d.cfg, now);
    if (!plan) return;
    if (isRefusal(plan) || isWait(plan)) {
      say(`convert: ${plan.kind} (${plan.reason})`);
      return;
    }
    say(`convert ${plan.amountIn} wei → minOut ${formatUsd6(plan.minOut)} USDG (floor ${formatUsd6(plan.floor)}, spot ${formatUsd6(plan.spotQuote)})`);
    await this.d.exec.convert(plan);
  }

  private async maybeExecute(vault: VaultSnapshot, gov: GovernanceSnapshot, universe: PerpMeta[], now: number, say: (s: string) => void): Promise<string> {
    const blocked = decisionExecutable(vault, gov, now);
    if (blocked) {
      say(`idle: ${blocked.reason}`);
      return "idle";
    }
    const route = {
      inputToken: vault.usdg,
      outputToken: vault.bridgeOutputToken,
      originChainId: this.d.cfg.chainId,
      destinationChainId: vault.destinationChainId,
    };
    const limits = await this.d.across.limits(route);
    const amount = bridgeAmount(vault, limits);
    if (amount === 0n) {
      say("execute: nothing to bridge yet (ledger empty)");
      return "idle";
    }
    const quote = await this.d.across.suggestedFees(route, amount, vault.bridgeRecipient);
    const plan = planExecute(vault, gov, universe, limits, quote, amount, this.d.cfg, now);
    if (isRefusal(plan) || isWait(plan)) {
      say(`execute: ${plan.kind} (${plan.reason})`);
      if (isRefusal(plan)) await this.d.alerts.warning("executeDecision refused", { reason: plan.reason });
      return plan.kind;
    }
    say(`execute decision ${plan.decisionId}: bridge ${formatUsd6(plan.amount)} USDG → ${formatUsd6(plan.outputAmount)} USDC (${plan.feeBps} bps, ~${plan.estimatedFillTimeSec}s) quoteTs=${plan.quoteTimestamp} fillDeadline=${plan.fillDeadline} for ${plan.coin} ${plan.side}`);
    const r = await this.d.exec.executeDecision(plan);
    if (r.done) {
      this.d.store.startRun(plan.decisionId, "bridging", {
        asset: plan.asset,
        coin: plan.coin,
        side: plan.side,
        capital: plan.amount.toString(),
        outputAmount: plan.outputAmount.toString(),
        depositId: (r.depositId ?? plan.expectedDepositId).toString(),
        executeTxHash: r.txHash,
      });
      await this.d.alerts.info("executeDecision sent", { decisionId: plan.decisionId, amount: plan.amount, txHash: r.txHash });
    }
    return "execute";
  }

  /** No run row for an open vault position (fresh install or lost DB): derive the stage from observed state. */
  private async adopt(vault: VaultSnapshot, perp: PerpMeta, say: (s: string) => void): Promise<Run> {
    const p = vault.position;
    const executed = await this.d.chain.orderExecuted(p.decisionId);
    const data = {
      asset: p.asset,
      coin: perp.name,
      side: p.side,
      capital: p.capital.toString(),
      outputAmount: (executed?.outputAmount ?? (p.capital * (BPS - BigInt(vault.maxBridgeFeeBps))) / BPS).toString(),
      depositId: p.depositId.toString(),
      notes: ["adopted from chain state"],
    };
    const state = await this.d.hl.clearinghouseState(this.d.cfg.hlTradingAccount);
    const hlPos = state.positions.find((x) => x.coin === perp.name);
    let stage: Stage = "bridging";
    if (hlPos) stage = "protecting";
    else if (cmpDecimals(state.withdrawable, "0") > 0) stage = "opening";
    else {
      const ds = await this.d.across.depositStatus(this.d.cfg.chainId, p.depositId);
      if (ds.status === "filled") stage = "funding";
    }
    say(`decision ${p.decisionId}: no local run, adopted at stage ${stage}`);
    await this.d.alerts.warning("run adopted from chain state", { decisionId: p.decisionId, stage });
    return this.d.store.startRun(p.decisionId, stage, data);
  }

  private async step(
    run: Run,
    vault: VaultSnapshot,
    gov: GovernanceSnapshot,
    perp: PerpMeta,
    state: HlAccountState,
    hlPos: HlPosition | undefined,
    now: number,
    say: (s: string) => void,
  ): Promise<Run> {
    const { cfg, exec, store, across } = this.d;
    const id = run.decisionId;
    const outputAmount = BigInt(run.data.outputAmount ?? "0");

    switch (run.stage) {
      case "bridging": {
        const ds = await across.depositStatus(cfg.chainId, BigInt(run.data.depositId ?? vault.position.depositId));
        say(`bridging: Across deposit ${run.data.depositId} status=${ds.status}`);
        if (ds.status === "filled") return store.transition(id, "funding", { bridgeFilledAt: this.now() });
        if (ds.status === "refunded" || (ds.status === "expired" && vault.usdgBalance > vault.usdgLedger)) {
          await this.d.alerts.warning("Across deposit refunded to the vault: closing the decision without trading", { decisionId: id });
          return store.transition(id, "awaiting_return", { closeReason: "bridge refunded", finalEquity: run.data.capital, closedOnHlAt: this.now() });
        }
        // the multisig may have moved the funds before the API caught up
        if (decimalToUsd6(state.withdrawable) >= (outputAmount * FUNDING_TOLERANCE_BPS) / BPS && outputAmount > 0n) {
          return store.transition(id, "funding", { bridgeFilledAt: this.now(), notes: [...(run.data.notes ?? []), "funds seen on HL before the API reported the fill"] });
        }
        return run;
      }
      case "funding": {
        if (hlPos) return store.transition(id, "protecting", { notes: [...(run.data.notes ?? []), "position found while funding"] });
        const have = decimalToUsd6(state.withdrawable);
        const need = (outputAmount * FUNDING_TOLERANCE_BPS) / BPS;
        if (have >= need && need > 0n) {
          say(`funding: ${state.withdrawable} USDC available on ${cfg.hlTradingAccount} (need ${formatUsd6(need)})`);
          return store.transition(id, "opening");
        }
        const key = `${id}`;
        if (!this.fundingInstructionsIssued.has(key)) {
          this.fundingInstructionsIssued.add(key);
          await this.d.alerts.warning("funds on HyperEVM: multisig action required", {
            decisionId: id,
            steps: [
              `1. On HyperEVM (999), the multisig's EVM key transfers ${formatUsd6(outputAmount)} USDC (${vault.bridgeOutputToken}) to the HyperCore system address 0x2000000000000000000000000000000000000000 (USDC → spot balance of ${vault.bridgeRecipient})`,
              `2. On HyperCore, the multisig signs usdClassTransfer (spot → perp)`,
              cfg.hlTradingAccount.toLowerCase() !== vault.bridgeRecipient.toLowerCase()
                ? `3. On HyperCore, the multisig signs subAccountTransfer to ${cfg.hlTradingAccount}`
                : "3. (trading on the master account: no sub-account transfer)",
            ],
          });
        }
        say(`funding: waiting for ${formatUsd6(need)} USDC on ${cfg.hlTradingAccount} (have ${state.withdrawable})`);
        return run;
      }
      case "opening": {
        if (hlPos) return store.transition(id, "protecting", { filledSize: hlPos.szi.replace("-", ""), avgEntryPx: hlPos.entryPx });
        if ((run.data.entryAttempts ?? 0) >= MAX_ENTRY_ATTEMPTS) {
          await this.d.alerts.critical("entry attempts exhausted: manual decision needed", { decisionId: id, attempts: run.data.entryAttempts });
          return run;
        }
        const mids = await this.d.hl.allMids();
        const mid = mids[perp.name] ?? "0";
        const plan = planOpen(vault, perp, mid, state.withdrawable, cfg);
        if (isRefusal(plan)) {
          say(`opening refused: ${plan.reason}`);
          await this.d.alerts.critical("openPosition refused", { decisionId: id, reason: plan.reason });
          return run;
        }
        say(`opening ${plan.coin} ${plan.side}: ${plan.size} @ ≤ ${plan.limitPx} (mid ${plan.mid}) ${plan.leverage}x isolated on margin ${plan.margin}`);
        const r = await exec.open(plan, run);
        if (!r.done) return run;
        const patch = { entryAttempts: r.attempts ?? (run.data.entryAttempts ?? 0) + 1, entryOids: r.oids, filledSize: r.filledSize, avgEntryPx: r.avgPx };
        if (r.filledSize && cmpDecimals(r.filledSize, "0") > 0) return store.transition(id, "protecting", patch);
        return store.patch(id, patch);
      }
      case "protecting": {
        if (!hlPos) {
          await this.d.alerts.critical("position vanished before it was protected", { decisionId: id });
          return store.transition(id, "closed_on_hl", { closeReason: "position gone while protecting", closedOnHlAt: this.now() });
        }
        const plan = planProtect(vault, perp, hlPos, { takeProfitTrigger: cfg.takeProfitTrigger });
        if (isRefusal(plan)) {
          say(`protect refused: ${plan.reason} → flatten (fail-closed)`);
          await this.d.alerts.critical("protect refused, flattening", { decisionId: id, reason: plan.reason });
          await this.flatten(run, perp, hlPos, `protect refused: ${plan.reason}`);
          return store.getRun(id) ?? run;
        }
        say(`protect ${plan.coin}: size ${plan.size} entry ${plan.entryPx} stop ${plan.stopLossPx}${plan.takeProfitPx ? ` tp ${plan.takeProfitPx}` : ""}`);
        const r = await exec.protect(plan, run);
        if (!r.done) return run;
        if (r.attempts !== undefined) run = store.patch(id, { protectAttempts: r.attempts });
        if (!r.verified) {
          await this.d.alerts.critical("stop-loss could not be verified, flattening", { decisionId: id });
          await this.flatten(run, perp, hlPos, "stop-loss not verified");
          return store.getRun(id) ?? run;
        }
        await this.d.alerts.info("position protected", { decisionId: id, coin: plan.coin, stop: plan.stopLossPx, tp: plan.takeProfitPx });
        return store.transition(id, "holding", { stopLossOid: r.stopLossOid, takeProfitOid: r.takeProfitOid, stopLossPx: plan.stopLossPx, takeProfitPx: plan.takeProfitPx });
      }
      case "holding": {
        if (!hlPos) {
          await this.d.alerts.warning("position closed on Hyperliquid (stop, take-profit or liquidation)", { decisionId: id, equity: state.accountValue });
          return store.transition(id, "closed_on_hl", { closeReason: "closed by trigger or liquidation", closedOnHlAt: this.now() });
        }
        const orders = await this.d.hl.frontendOpenOrders(cfg.hlTradingAccount);
        const stop = orders.find((o) => o.coin === perp.name && o.isTrigger && o.reduceOnly && o.orderType.toLowerCase().includes("stop"));
        if (!stop) {
          await this.d.alerts.critical("stop-loss missing while holding: re-protecting", { decisionId: id });
          return store.transition(id, "protecting");
        }
        const lastReportAt = run.data.lastReportAt ?? 0;
        if (this.now() - lastReportAt >= cfg.reportIntervalMs) {
          const equity = decimalToUsd6(state.accountValue);
          say(`holding: report equity ${state.accountValue} USDC (unrealized ${hlPos.unrealizedPnl})`);
          const r = await exec.reportPosition(id, equity);
          if (r.done) return store.patch(id, { lastReportAt: this.now(), lastReportedEquity: equity.toString() });
        } else {
          say(`holding: stop ${stop.triggerPx} present, next report in ${Math.round((cfg.reportIntervalMs - (this.now() - lastReportAt)) / 1000)}s`);
        }
        return run;
      }
      case "closing": {
        if (!hlPos) return store.transition(id, "closed_on_hl", { closedOnHlAt: this.now() });
        await this.flatten(run, perp, hlPos, run.data.closeReason ?? "close");
        return store.getRun(id) ?? run;
      }
      case "closed_on_hl": {
        if (hlPos) {
          await this.d.alerts.critical("position re-appeared after close", { decisionId: id });
          return store.transition(id, "closing", { closeReason: "position re-appeared" });
        }
        const equity = decimalToUsd6(state.accountValue);
        say(`closed on HL: equity ${formatUsd6(equity)} USDC must come back to the vault (multisig)`);
        const r = await exec.returnInstructions({ decisionId: id, equity, coin: perp.name });
        if (!r.done) return run;
        return store.transition(id, "awaiting_return", { finalEquity: equity.toString(), returnPlanIssuedAt: this.now() });
      }
      case "awaiting_return": {
        const returned = vault.usdgBalance - vault.usdgLedger;
        const expected = BigInt(run.data.finalEquity ?? "0");
        const threshold = (expected * BigInt(cfg.returnToleranceBps)) / BPS;
        const forced = cfg.forceReportClosedId === id;
        say(`awaiting return: ${formatUsd6(returned)} / ${formatUsd6(expected)} USDG back on the vault (threshold ${formatUsd6(threshold)})${forced ? " [FORCED]" : ""}`);
        if ((returned >= threshold && (returned > 0n || expected === 0n)) || forced) {
          const r = await exec.reportClosed(id);
          if (r.done) return store.transition(id, "report_closed", { reportClosedTxHash: r.txHash, reportClosedAt: this.now() });
          return run;
        }
        const issuedAt = run.data.returnPlanIssuedAt ?? run.updatedAt;
        if (this.now() - issuedAt > cfg.returnWaitMs) {
          await this.d.alerts.critical("funds not back after the return timeout: escalate to the multisig signers", { decisionId: id, returned, expected });
        }
        return run;
      }
      case "report_closed":
      case "finalized":
        say(`stage ${run.stage}: waiting for the chain`);
        return run;
    }
  }

  /** Cancel + reduce-only close, then record the outcome. */
  private async flatten(run: Run, perp: PerpMeta, hlPos: HlPosition, reason: string): Promise<void> {
    const mids = await this.d.hl.allMids();
    const plan = planClose(perp, hlPos, mids[perp.name] ?? "0", this.d.cfg.entrySlippageBps, reason);
    if (isRefusal(plan)) {
      await this.d.alerts.critical("close plan refused", { decisionId: run.decisionId, reason: plan.reason });
      return;
    }
    this.log.info(`close ${plan.coin}: ${plan.isBuy ? "buy" : "sell"} ${plan.size} @ ${plan.limitPx} reduce-only (${reason})`);
    const r = await this.d.exec.close(plan, run);
    if (r.done && r.flat) this.d.store.transition(run.decisionId, "closed_on_hl", { closeReason: reason, closedOnHlAt: this.now() });
    else if (r.done) this.d.store.transition(run.decisionId, "closing", { closeReason: reason });
  }

  private async checkAgentExpiry(): Promise<void> {
    if (!this.d.agentAddress) return;
    const agents = await this.d.hl.extraAgents(this.d.cfg.hlAccount);
    const me = agents.find((a) => a.address.toLowerCase() === this.d.agentAddress!.toLowerCase());
    if (!me) {
      await this.d.alerts.critical("agent not approved on the Hyperliquid account", { agent: this.d.agentAddress, account: this.d.cfg.hlAccount });
      return;
    }
    const left = me.validUntil - this.now();
    if (left < this.d.cfg.agentExpiryWarnMs) {
      await this.d.alerts.warning("agent expires soon: rotate it (multisig approveAgent with a NEW address)", { agent: me.address, validUntil: me.validUntil, hoursLeft: Math.floor(left / 3_600_000) });
    }
  }
}

export { usd6ToDecimal };
