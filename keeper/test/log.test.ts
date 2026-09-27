import { describe, expect, it } from "vitest";
import { Alerts, ConsoleAlertSink, defaultAlerts, WebhookAlertSink } from "../src/log.js";

describe("alerts", () => {
  it("posts JSON to the webhook and never throws on failure", async () => {
    const calls: { url: string; body: string }[] = [];
    let fail = false;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (fail) throw new Error("network down");
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const alerts = new Alerts([new WebhookAlertSink("http://hook", fetchFn)]);
    await alerts.critical("KILL SWITCH", { reason: "test", amount: 5n });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ source: "warchest-keeper", severity: "critical", title: "KILL SWITCH", detail: { reason: "test", amount: "5" } });
    fail = true;
    await expect(alerts.warning("still fine")).resolves.toBeUndefined();
    expect(alerts.sent.map((a) => a.title)).toEqual(["KILL SWITCH", "still fine"]);
  });
  it("defaultAlerts adds the webhook sink only when configured", () => {
    expect(defaultAlerts(undefined)["sinks"]).toHaveLength(1);
    expect(defaultAlerts("http://x")["sinks"]).toHaveLength(2);
    expect(new ConsoleAlertSink()).toBeDefined();
  });
});
