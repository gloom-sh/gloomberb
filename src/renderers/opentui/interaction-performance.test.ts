import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CliRenderer } from "@opentui/core";
import {
  installInteractionPerformanceRecorder,
  summarizeInteractionPerformance,
  type InteractionPerformanceSample,
} from "./interaction-performance";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sample(latencyMs: number): InteractionPerformanceSample {
  return {
    id: latencyMs,
    key: "down",
    frameId: 1,
    inputsInFrame: 1,
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

test("waits for the key's React commit before attributing a renderer frame", () => {
  const directory = mkdtempSync(join(tmpdir(), "gloomberb-interaction-performance-"));
  temporaryDirectories.push(directory);
  const output = join(directory, "report.json");
  const rendererEvents = new EventEmitter();
  const keyInput = new EventEmitter();
  const renderer = Object.assign(rendererEvents, {
    keyInput,
    setGatherStats: () => {},
    getStats: () => ({ frameCallbackTime: 1.25, cellsUpdated: 42 }),
  }) as unknown as CliRenderer;
  const recorder = installInteractionPerformanceRecorder(renderer, output);

  keyInput.emit("keypress", { name: "down" });
  keyInput.emit("keypress", { name: "up" });
  rendererEvents.emit("frame", { frameId: 10 });
  recorder.markCommit();
  rendererEvents.emit("frame", { frameId: 11 });
  recorder();

  const report = JSON.parse(readFileSync(output, "utf8")) as {
    unframedInputCount: number;
    samples: InteractionPerformanceSample[];
  };
  expect(report.unframedInputCount).toBe(0);
  expect(report.samples).toHaveLength(2);
  expect(report.samples.map((entry) => entry.key)).toEqual(["down", "up"]);
  for (const entry of report.samples) {
    expect(entry).toMatchObject({
      frameId: 11,
      inputsInFrame: 2,
      frameCallbackMs: 1.25,
      cellsUpdated: 42,
    });
  }
});
