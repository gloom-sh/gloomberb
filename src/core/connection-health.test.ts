import { describe, expect, test } from "bun:test";
import { ConnectionHealthRegistry } from "./connection-health";

function source(id = "quotes") {
  return { id, name: "Quotes", kind: "asset-data" as const, ownerId: "test" };
}

describe("ConnectionHealthRegistry", () => {
  test("registers, notifies, and removes only the active registration", () => {
    const health = new ConnectionHealthRegistry();
    let notifications = 0;
    const unsubscribe = health.subscribe(() => notifications++);
    const disposeFirst = health.registerSource(source());
    const disposeSecond = health.registerSource({ ...source(), name: "Replacement" });

    disposeFirst();
    expect(health.getSnapshot().sources.map((entry) => entry.name)).toEqual(["Replacement"]);

    disposeSecond();
    expect(health.getSnapshot().sources).toEqual([]);
    expect(notifications).toBe(3);
    unsubscribe();
  });

  test("attributes success, error, latency, and recent outcomes to the source", async () => {
    let now = 100;
    let clock = 20;
    const health = new ConnectionHealthRegistry({ now: () => now, clock: () => clock });
    health.registerSource(source());

    const result = await health.track("quotes", "getQuote", async () => {
      clock = 32.5;
      return 42;
    });
    now = 200;
    clock = 40;
    await expect(health.track("quotes", "getHistory", async () => {
      clock = 47;
      throw new Error("rate limited");
    })).rejects.toThrow("rate limited");

    const state = health.getSnapshot().sources[0]!;
    expect(result).toBe(42);
    expect(state.status).toBe("error");
    expect(state.lastSuccess).toMatchObject({ operation: "getQuote", latencyMs: 12.5, at: 100 });
    expect(state.lastError).toMatchObject({ operation: "getHistory", latencyMs: 7, at: 200, error: "rate limited" });
    expect(state.recentRequests.map((entry) => entry.operation)).toEqual(["getHistory", "getQuote"]);
  });

  test("replays reports made before the source and pane are initialized", () => {
    const health = new ConnectionHealthRegistry({ now: () => 500 });
    health.reportRequest("news", {
      operation: "fetchNews",
      success: true,
      latencyMs: 18,
    });

    health.registerSource({ id: "news", name: "News", kind: "news" });

    expect(health.getSnapshot().sources[0]).toMatchObject({
      id: "news",
      status: "connected",
      lastLatencyMs: 18,
      lastRequestAt: 500,
    });
  });
});
