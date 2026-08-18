import { describe, expect, test } from "bun:test";
import { createCliPaneShotConnectionHealth } from "./cli-pane-shot-health";

describe("CLI pane shot connection health", () => {
  test("seeds stable request, socket, and error rows", () => {
    const sources = createCliPaneShotConnectionHealth(1_000).getSnapshot().sources;

    expect(sources.map((source) => source.id)).toEqual([
      "gloom-cloud-http",
      "gloom-cloud-socket",
      "asset-data.yahoo",
    ]);
    expect(sources.map((source) => ({
      status: source.status,
      operation: source.lastOperation,
      latency: source.lastLatencyMs,
    }))).toEqual([
      { status: "connected", operation: "GET /market/quotes", latency: 84 },
      { status: "connected", operation: null, latency: null },
      { status: "error", operation: "getPriceHistory", latency: 240 },
    ]);
  });
});
