import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { HttpAcrossApi } from "./across/api.js";
import { RpcChainReader } from "./chain/reader.js";
import { loadConfig, type Config } from "./config.js";
import { DryRunExecutor, type Executor } from "./executor.js";
import { TradingEngine } from "./hyperliquid/engine.js";
import { HttpHyperliquidExchange } from "./hyperliquid/exchange.js";
import { HttpHyperliquidInfo } from "./hyperliquid/info.js";
import { AgentSigner } from "./hyperliquid/signer.js";
import { Keeper } from "./keeper.js";
import { defaultAlerts, Logger, type Alerts } from "./log.js";
import { Monitor } from "./monitor.js";
import { Store } from "./store.js";

const log = new Logger("cli");

export interface Wiring {
  cfg: Config;
  keeper: Keeper;
  store: Store;
  exec: Executor;
}

/** Hyperliquid trading engine bound to the agent key (live mode only). */
export function buildEngine(cfg: Config, hl: HttpHyperliquidInfo, alerts: Alerts): TradingEngine {
  if (!cfg.hlAgentKey) throw new Error("HL_AGENT_PRIVATE_KEY required");
  const signer = new AgentSigner(privateKeyToAccount(cfg.hlAgentKey), cfg.hlNetwork === "mainnet");
  const exchange = new HttpHyperliquidExchange(cfg.hlExchangeUrl, signer, {
    vaultAddress: cfg.hlTradingAccount.toLowerCase() !== cfg.hlAccount.toLowerCase() ? cfg.hlTradingAccount : undefined,
    actionTtlMs: cfg.actionTtlMs,
  });
  return new TradingEngine(exchange, hl, alerts, {
    tradingAccount: cfg.hlTradingAccount,
    killSlippageBps: cfg.killSlippageBps,
    triggerLimitBps: cfg.triggerLimitBps,
    deadManMs: cfg.deadManMs,
    verifyAttempts: 5,
    verifyDelayMs: 1000,
  });
}

/** Independent monitor (read-only unless MONITOR_KILL=1 and the agent key is present). */
export function buildMonitor(cfg: Config): Monitor {
  const chain = new RpcChainReader(cfg.rpcUrl, cfg.vault, cfg.governance, cfg.quoter);
  const hl = new HttpHyperliquidInfo(cfg.hlInfoUrl);
  const alerts = defaultAlerts(cfg.alertWebhookUrl);
  const agentAddress = cfg.hlAgentKey ? privateKeyToAccount(cfg.hlAgentKey).address : undefined;
  const kill = cfg.monitorKill && cfg.mode === "live" ? (reason: string) => buildEngine(cfg, hl, alerts).killSwitch(reason) : undefined;
  return new Monitor({ chain, hl, alerts, tradingAccount: cfg.hlTradingAccount, hlAccount: cfg.hlAccount, allowedAssets: cfg.allowedAssets, agentAddress, agentExpiryWarnMs: cfg.agentExpiryWarnMs, kill });
}

/** Builds the keeper from the environment. Live executors are wired by later slices; dry-run is always available. */
export function wire(cfg: Config = loadConfig()): Wiring {
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const store = new Store(cfg.dbPath);
  const chain = new RpcChainReader(cfg.rpcUrl, cfg.vault, cfg.governance, cfg.quoter);
  const hl = new HttpHyperliquidInfo(cfg.hlInfoUrl);
  const across = new HttpAcrossApi(cfg.acrossApiUrl);
  const alerts = defaultAlerts(cfg.alertWebhookUrl);
  if (cfg.mode === "live") throw new Error("live mode is not wired yet (S5.2–S5.4)");
  const exec = new DryRunExecutor();
  const keeper = new Keeper({
    cfg,
    chain,
    hl,
    across,
    exec,
    store,
    alerts,
    keeperAddress: cfg.keeperKey ? privateKeyToAccount(cfg.keeperKey).address : undefined,
    agentAddress: cfg.hlAgentKey ? privateKeyToAccount(cfg.hlAgentKey).address : undefined,
  });
  return { cfg, keeper, store, exec };
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "help";
  switch (cmd) {
    case "once": {
      const { keeper, store } = wire();
      const r = await keeper.tick();
      log.info(`phase=${r.phase} decision=${r.decisionId}`);
      store.close();
      return 0;
    }
    case "run": {
      const { cfg, keeper, store } = wire();
      log.info(`keeper loop mode=${cfg.mode} chain=${cfg.chainId} hl=${cfg.hlNetwork} every ${cfg.intervalMs}ms`);
      let stop = false;
      const onSignal = () => {
        log.info("stopping after the current tick");
        stop = true;
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      let failures = 0;
      while (!stop) {
        const started = Date.now();
        try {
          const r = await keeper.tick();
          failures = 0;
          log.info(`tick ok phase=${r.phase} decision=${r.decisionId} (${Date.now() - started}ms)`);
        } catch (e) {
          failures++;
          log.error(`tick failed (${failures} in a row)`, { error: e instanceof Error ? e.message : String(e) });
        }
        const backoff = Math.min(cfg.intervalMs * 2 ** Math.min(failures, 4), 10 * 60_000);
        await new Promise((r) => setTimeout(r, failures ? backoff : cfg.intervalMs));
      }
      store.close();
      return 0;
    }
    case "monitor": {
      const cfg = loadConfig();
      const monitor = buildMonitor(cfg);
      const once = argv[1] === "once";
      log.info(`monitor mode=${cfg.mode} kill=${cfg.monitorKill && cfg.mode === "live"} every ${cfg.intervalMs}ms`);
      let stop = false;
      process.on("SIGINT", () => (stop = true));
      process.on("SIGTERM", () => (stop = true));
      do {
        try {
          const findings = await monitor.run();
          if (once) return findings.some((f) => f.level === "red") ? 2 : 0;
        } catch (e) {
          log.error("monitor failed", { error: e instanceof Error ? e.message : String(e) });
        }
        await new Promise((r) => setTimeout(r, cfg.intervalMs));
      } while (!stop);
      return 0;
    }
    case "kill": {
      const cfg = loadConfig();
      if (cfg.mode !== "live") throw new Error("kill requires MODE=live (it signs cancel + reduce-only orders with the agent key)");
      const hl = new HttpHyperliquidInfo(cfg.hlInfoUrl);
      const r = await buildEngine(cfg, hl, defaultAlerts(cfg.alertWebhookUrl)).killSwitch(argv[1] ?? "manual");
      log.info(`kill switch done flat=${r.flat}`);
      return r.flat ? 0 : 2;
    }
    case "status": {
      const cfg = loadConfig();
      const store = new Store(cfg.dbPath);
      for (const r of store.runs()) console.log(JSON.stringify({ decisionId: r.decisionId.toString(), stage: r.stage, updatedAt: new Date(r.updatedAt).toISOString(), ...r.data }));
      for (const e of store.events(20).reverse()) console.log(`${new Date(e.at).toISOString()} ${e.decisionId ?? "-"} ${e.kind} ${e.data}`);
      store.close();
      return 0;
    }
    default:
      console.log("usage: keeper <once|run|status|monitor [once]|kill [reason]>");
      return cmd === "help" ? 0 : 1;
  }
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      log.error("fatal", { error: e instanceof Error ? e.message : String(e) });
      process.exit(1);
    },
  );
}
