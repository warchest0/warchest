import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

describe("Store", () => {
  it("starts a run once and transitions with an event trail", () => {
    const s = new Store();
    const r = s.startRun(1n, "bridging", { coin: "ETH", capital: "100" }, 1000);
    expect(r.stage).toBe("bridging");
    expect(s.startRun(1n, "holding", {}, 2000).stage).toBe("bridging"); // idempotent
    const t = s.transition(1n, "funding", { bridgeFilledAt: 5 }, 3000);
    expect(t.data).toEqual({ coin: "ETH", capital: "100", bridgeFilledAt: 5 });
    expect(s.getRun(1n)?.stage).toBe("funding");
    const kinds = s.events(10, 1n).map((e) => e.kind);
    expect(kinds).toEqual(["run.transition", "run.start"]);
    expect(() => s.transition(2n, "funding")).toThrow(/no run/);
    s.close();
  });
  it("patches data without changing the stage and lists runs", () => {
    const s = new Store();
    s.startRun(3n, "holding", {});
    s.startRun(2n, "finalized", {});
    s.patch(3n, { lastReportAt: 42 });
    expect(s.getRun(3n)).toMatchObject({ stage: "holding", data: { lastReportAt: 42 } });
    expect(s.runs().map((r) => r.decisionId)).toEqual([2n, 3n]);
    s.setMeta("k", "v");
    expect(s.getMeta("k")).toBe("v");
    expect(s.getMeta("none")).toBeUndefined();
    s.close();
  });
});
