import { describe, expect, test } from "bun:test";
import {
  ConnectionHealthRegistry,
  registerGloomCloudConnectionSources,
} from "./connection-health";

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

  test("keeps source disposal scoped to its registry", () => {
    const first = new ConnectionHealthRegistry();
    const second = new ConnectionHealthRegistry();
    const disposeFirst = registerGloomCloudConnectionSources(first);
    registerGloomCloudConnectionSources(second);

    disposeFirst();

    expect(first.getSnapshot().sources).toEqual([]);
    expect(second.getSnapshot().sources.map((entry) => entry.id)).toEqual([
      "gloom-cloud-http",
      "gloom-cloud-socket",
    ]);
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

  test("drops reports without an active source registration", () => {
    const health = new ConnectionHealthRegistry({ now: () => 500 });
    health.reportRequest("news", {
      operation: "fetchNews",
      success: true,
      latencyMs: 18,
    });

    health.registerSource({ id: "news", name: "News", kind: "news" });

    expect(health.getSnapshot().sources[0]).toMatchObject({
      id: "news",
      status: "idle",
      lastRequestAt: null,
    });
  });

  test("drops in-flight completions after disposal instead of applying them to a replacement", async () => {
    let complete!: (value: number) => void;
    const health = new ConnectionHealthRegistry();
    const dispose = health.registerSource(source());
    const request = health.track("quotes", "getQuote", () => new Promise<number>((resolve) => {
      complete = resolve;
    }));

    dispose();
    health.registerSource({ ...source(), name: "Replacement" });
    complete(42);

    await expect(request).resolves.toBe(42);
    expect(health.getSnapshot().sources[0]).toMatchObject({
      name: "Replacement",
      status: "idle",
      lastRequestAt: null,
    });
  });

  test("returns request outcomes to idle after the freshness window", () => {
    let now = 100;
    const health = new ConnectionHealthRegistry({ now: () => now, requestStatusTtlMs: 1_000 });
    health.registerSource(source());
    health.reportRequest("quotes", { operation: "getQuote", success: true, latencyMs: 5 });

    expect(health.getSnapshot().sources[0]?.status).toBe("connected");
    now = 1_100;
    expect(health.getSnapshot().sources[0]).toMatchObject({
      status: "idle",
      lastOperation: "getQuote",
      lastLatencyMs: 5,
    });
  });

  test("overlays external sources by canonical id without duplicate rows", () => {
    const renderer = new ConnectionHealthRegistry();
    renderer.registerSource({ id: "gloom-cloud-http", name: "Local HTTP", kind: "api" });
    const backend = new ConnectionHealthRegistry();
    backend.registerSource({ id: "gloom-cloud-http", name: "Backend HTTP", kind: "api" });
    backend.reportRequest("gloom-cloud-http", { operation: "GET /market/quotes", success: true, latencyMs: 12 });

    renderer.replaceExternalSnapshot("backend", backend.getSnapshot());
    expect(renderer.getSnapshot().sources).toHaveLength(1);
    expect(renderer.getSnapshot().sources[0]).toMatchObject({
      id: "gloom-cloud-http",
      name: "Backend HTTP",
      status: "connected",
    });

    renderer.clearExternalSnapshot("backend");
    expect(renderer.getSnapshot().sources[0]).toMatchObject({
      id: "gloom-cloud-http",
      name: "Local HTTP",
      status: "idle",
    });
  });
});
