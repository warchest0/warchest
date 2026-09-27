/** Structured logging and pluggable alerting (console + optional webhook). */

export type Level = "debug" | "info" | "warn" | "error";
export type Severity = "info" | "warning" | "critical";

export interface Alert {
  severity: Severity;
  title: string;
  detail?: Record<string, unknown>;
  at: number;
}

export interface AlertSink {
  send(alert: Alert): Promise<void>;
}

const json = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Error ? { error: x.message } : x));

export class Logger {
  constructor(private readonly scope: string, private readonly minLevel: Level = "info") {}

  private static order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

  log(level: Level, msg: string, data?: Record<string, unknown>): void {
    if (Logger.order[level] < Logger.order[this.minLevel]) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${msg}${data ? " " + json(data) : ""}`;
    if (level === "error") console.error(line);
    else console.log(line);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.log("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.log("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.log("error", msg, data);
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.minLevel);
  }
}

export class ConsoleAlertSink implements AlertSink {
  constructor(private readonly log = new Logger("alert")) {}
  async send(a: Alert): Promise<void> {
    this.log.log(a.severity === "critical" ? "error" : a.severity === "warning" ? "warn" : "info", a.title, a.detail);
  }
}

/** POSTs the alert as JSON. Failures are logged, never thrown: alerting must not break the loop. */
export class WebhookAlertSink implements AlertSink {
  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly log = new Logger("alert:webhook"),
  ) {}
  async send(a: Alert): Promise<void> {
    try {
      const res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json({ source: "warchest-keeper", ...a }),
      });
      if (!res.ok) this.log.warn(`webhook responded ${res.status}`);
    } catch (e) {
      this.log.warn("webhook failed", { error: e });
    }
  }
}

export class Alerts {
  readonly sent: Alert[] = [];
  constructor(private readonly sinks: AlertSink[]) {}

  async emit(severity: Severity, title: string, detail?: Record<string, unknown>): Promise<void> {
    const alert: Alert = { severity, title, detail, at: Date.now() };
    this.sent.push(alert);
    if (this.sent.length > 1000) this.sent.shift();
    await Promise.all(this.sinks.map((s) => s.send(alert)));
  }

  info(title: string, detail?: Record<string, unknown>): Promise<void> {
    return this.emit("info", title, detail);
  }
  warning(title: string, detail?: Record<string, unknown>): Promise<void> {
    return this.emit("warning", title, detail);
  }
  critical(title: string, detail?: Record<string, unknown>): Promise<void> {
    return this.emit("critical", title, detail);
  }
}

export function defaultAlerts(webhookUrl?: string): Alerts {
  const sinks: AlertSink[] = [new ConsoleAlertSink()];
  if (webhookUrl) sinks.push(new WebhookAlertSink(webhookUrl));
  return new Alerts(sinks);
}
