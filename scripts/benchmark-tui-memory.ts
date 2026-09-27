import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createDefaultConfig } from "../src/types/config";
import { sendRemoteControlRequest } from "../src/remote/client";
import { positiveInteger, runTmux, shellQuote, takeOption, waitForFile } from "./tui-benchmark-harness";

/**
 * Opens one ticker after another in a sandboxed TUI and checks that memory
 * levels off. The market data stores keep at most 64 unwatched entries each
 * (#945), so past that point browsing another ticker should cost nothing that
 * stays. The live heap is read after a full collection (see heap-probe.ts);
 * RSS rises and falls with the collector and cannot tell a leak from a late GC.
 */

// Liquid US listings, so every one resolves on the free delayed feed.
const TICKERS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "BRK-B", "JPM",
  "LLY", "V", "UNH", "XOM", "MA", "JNJ", "PG", "HD", "COST", "ABBV",
  "MRK", "CVX", "ORCL", "KO", "PEP", "ADBE", "WMT", "BAC", "CRM", "NFLX",
  "AMD", "TMO", "MCD", "CSCO", "ACN", "LIN", "ABT", "INTC", "DHR", "WFC",
  "DIS", "TXN", "PM", "CAT", "VZ", "INTU", "AMGN", "IBM", "QCOM", "NEE",
  "UNP", "GE", "HON", "LOW", "SPGI", "AMAT", "RTX", "BA", "GS", "NKE",
  "PFE", "ISRG", "T", "BKNG", "ELV", "SBUX", "MDT", "BLK", "PLD", "DE",
  "LMT", "SYK", "GILD", "ADP", "MDLZ", "TJX", "CB", "MMC", "ADI", "VRTX",
  "REGN", "C", "SCHW", "MO", "LRCX", "CI", "ZTS", "BSX", "SO", "PGR",
  "ETN", "MU", "DUK", "BDX", "SLB", "EQIX", "AON", "ITW", "CME", "NOC",
  "PANW", "APD", "CSX", "CL", "SNPS", "ICE", "SHW", "KLAC", "WM", "MCK",
  "FCX", "EOG", "CDNS", "USB", "GD", "HUM", "EMR", "MPC", "PNC", "ORLY",
] as const;

const options = parseOptions(process.argv.slice(2));
const session = `gloomberb-mem-${process.pid}`;
const sandbox = await mkdtemp(join(tmpdir(), "gloomberb-mem-"));
const sandboxHome = join(sandbox, "home");
const dataDir = join(sandboxHome, ".gloomberb");
const heapLog = join(sandbox, "heap.log");

try {
  if (!Bun.which("tmux")) throw new Error("tmux is required for the TUI memory benchmark.");
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, "config.json"),
    `${JSON.stringify({ ...createDefaultConfig(dataDir), onboardingComplete: true }, null, 2)}\n`,
    "utf8",
  );
  await runTmux(["new-session", "-d", "-s", session, "-x", "140", "-y", "45", "-c", options.root,
    `env HOME=${shellQuote(sandboxHome)} GLOOMBERB_HEAP_PROBE=${shellQuote(heapLog)} `
    + `bun --preload ${shellQuote(join(import.meta.dir, "heap-probe.ts"))} src/cli/entry.ts`]);

  const endpointPath = join(dataDir, "remote-control.tui.json");
  // A cold checkout (every CI run) transpiles the whole app on first launch.
  await waitForFile(endpointPath, 60_000);
  const { pid } = JSON.parse(await readFile(endpointPath, "utf8")) as { pid: number };
  await Bun.sleep(3_000);

  const samples: Array<{ tickers: number; heapMiB: number }> = [{ tickers: 0, heapMiB: await heapMiB(pid) }];
  const tickers = TICKERS.slice(0, options.count);
  for (const [index, symbol] of tickers.entries()) {
    const response = await sendRemoteControlRequest(
      { type: "call", operation: "ticker.navigate", input: { symbol } },
      { dataDir, appKind: "tui" },
    );
    if (!response.ok) throw new Error(`ticker.navigate ${symbol} failed: ${JSON.stringify(response)}`);
    await Bun.sleep(options.intervalMs);
    samples.push({ tickers: index + 1, heapMiB: await heapMiB(pid) });
  }

  // Judge the stretch after every capped store is full.
  const late = samples.filter((sample) => sample.tickers > options.plateauAfter);
  const lateSlope = slope(late);
  const result = {
    tickers: tickers.length,
    startHeapMiB: samples[0]!.heapMiB,
    endHeapMiB: samples.at(-1)!.heapMiB,
    earlyMiBPerTicker: round(slope(samples.filter((sample) => sample.tickers <= options.plateauAfter))),
    lateMiBPerTicker: round(lateSlope),
    maxLateMiBPerTicker: options.maxSlope,
    samples,
  };
  console.log(JSON.stringify(result, null, 2));
  if (lateSlope > options.maxSlope) {
    console.error(
      `Memory kept growing ${round(lateSlope)} MiB per ticker after ${options.plateauAfter} tickers `
      + `(limit ${options.maxSlope}).`,
    );
    process.exitCode = 1;
  }
} finally {
  await runTmux(["kill-session", "-t", session], false);
  await rm(sandbox, { recursive: true, force: true });
}

async function heapMiB(pid: number): Promise<number> {
  const before = await readHeapLog();
  try {
    process.kill(pid, "SIGUSR2");
  } catch {
    throw new Error(`The app (pid ${pid}) is no longer running.`);
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const lines = await readHeapLog();
    if (lines.length > before.length) return round(Number(lines.at(-1)) / 1024 / 1024);
    await Bun.sleep(50);
  }
  throw new Error("The heap probe did not answer; is the app running with --preload?");
}

async function readHeapLog(): Promise<string[]> {
  const text = await readFile(heapLog, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

/** Least-squares MiB per ticker. */
function slope(points: ReadonlyArray<{ tickers: number; heapMiB: number }>): number {
  if (points.length < 2) return 0;
  const meanX = points.reduce((sum, point) => sum + point.tickers, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.heapMiB, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.tickers - meanX) * (point.heapMiB - meanY);
    denominator += (point.tickers - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseOptions(args: string[]) {
  const count = positiveInteger(takeOption(args, "--count"), TICKERS.length, "count");
  if (count > TICKERS.length) throw new Error(`count can be at most ${TICKERS.length}.`);
  return {
    count,
    intervalMs: positiveInteger(takeOption(args, "--interval"), 1_000, "interval"),
    plateauAfter: positiveInteger(takeOption(args, "--plateau-after"), 72, "plateau-after"),
    // Measured on 120 tickers: 0.04 MiB/ticker with the #945 cap, 0.81 without it.
    maxSlope: Number(takeOption(args, "--max-slope") ?? 0.3),
    root: resolve(takeOption(args, "--root") ?? join(import.meta.dir, "..")),
  };
}
