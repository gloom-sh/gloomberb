import { expect, test } from "bun:test";
import {
  summarizeInteractionPerformance,
  type InteractionPerformanceSample,
} from "./interaction-performance";

function sample(latencyMs: number): InteractionPerformanceSample {
  return {
    id: latencyMs,
    key: "down",
    frameId: 1,
    latencyMs,
    frameCallbackMs: 0,
    cellsUpdated: 0,
    rssBytes: 0,
  };
}

test("summarizes key-to-frame latency with nearest-rank percentiles", () => {
  const samples = Array.from({ length: 20 }, (_, index) => sample(index + 1));
  expect(summarizeInteractionPerformance(samples)).toEqual({
    count: 20,
    p50Ms: 10,
    p95Ms: 19,
    maxMs: 20,
  });
});
