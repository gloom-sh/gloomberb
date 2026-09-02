import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import type { CliRenderer, CliRendererStats } from "@opentui/core";

const SAFE_INTERACTION_KEYS = new Set([
  "up",
  "down",
  "left",
  "right",
  "pageup",
  "pagedown",
  "home",
  "end",
  "enter",
  "return",
  "tab",
  "escape",
]);

interface PendingInteraction {
  id: number;
  key: string;
  startedAtMs: number;
}

export interface InteractionPerformanceSample {
  id: number;
  key: string;
  frameId: number;
  latencyMs: number;
  frameCallbackMs: number;
  cellsUpdated: number;
  rssBytes: number;
}

export interface InteractionPerformanceSummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

export function summarizeInteractionPerformance(
  samples: readonly InteractionPerformanceSample[],
): InteractionPerformanceSummary {
  const latencies = samples.map((sample) => sample.latencyMs).sort((left, right) => left - right);
  return {
    count: latencies.length,
    p50Ms: round(percentile(latencies, 0.5)),
    p95Ms: round(percentile(latencies, 0.95)),
    maxMs: round(latencies.at(-1) ?? 0),
  };
}

function statsForFrame(renderer: CliRenderer): CliRendererStats {
  try {
    return renderer.getStats();
  } catch {
    return {
      fps: 0,
      frameCount: 0,
      frameTimes: [],
      averageFrameTime: 0,
      minFrameTime: 0,
      maxFrameTime: 0,
      frameCallbackTime: 0,
      nativeLastFrameTime: 0,
      nativeAverageFrameTime: 0,
      nativeFrameCount: 0,
      cellsUpdated: 0,
      averageCellsUpdated: 0,
    };
  }
}

/**
 * Opt-in key-to-frame telemetry for repeatable tmux benchmarks. The recorder
 * ignores printable keys, buffers in memory, and writes once during renderer
 * shutdown so measurement does not add filesystem work to the hot path.
 */
export function installInteractionPerformanceRecorder(
  renderer: CliRenderer,
  outputPath = process.env.GLOOMBERB_INTERACTION_PERF,
): () => void {
  if (!outputPath) return () => {};

  const startedAt = new Date().toISOString();
  const pending: PendingInteraction[] = [];
  const samples: InteractionPerformanceSample[] = [];
  let nextId = 1;
  let stopped = false;

  renderer.setGatherStats(true);

  const onKeypress = (event: { name?: string }) => {
    const key = event.name?.toLowerCase() ?? "";
    if (!SAFE_INTERACTION_KEYS.has(key)) return;
    pending.push({ id: nextId++, key, startedAtMs: performance.now() });
  };
  const onFrame = (event: { frameId: number }) => {
    if (pending.length === 0) return;
    const completedAtMs = performance.now();
    const stats = statsForFrame(renderer);
    const rssBytes = process.memoryUsage.rss();
    for (const interaction of pending.splice(0)) {
      samples.push({
        id: interaction.id,
        key: interaction.key,
        frameId: event.frameId,
        latencyMs: round(completedAtMs - interaction.startedAtMs),
        frameCallbackMs: round(stats.frameCallbackTime),
        cellsUpdated: stats.cellsUpdated,
        rssBytes,
      });
    }
  };

  renderer.keyInput.on("keypress", onKeypress);
  renderer.on("frame", onFrame);

  return () => {
    if (stopped) return;
    stopped = true;
    renderer.keyInput.off("keypress", onKeypress);
    renderer.off("frame", onFrame);

    const byKey = Object.fromEntries(
      [...new Set(samples.map((sample) => sample.key))]
        .sort()
        .map((key) => [
          key,
          summarizeInteractionPerformance(samples.filter((sample) => sample.key === key)),
        ]),
    );
    const report = {
      version: 1,
      startedAt,
      endedAt: new Date().toISOString(),
      summary: summarizeInteractionPerformance(samples),
      byKey,
      unframedInputCount: pending.length,
      samples,
    };
    const target = resolve(outputPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
}
