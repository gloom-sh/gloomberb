import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createDefaultConfig, TICKER_RESEARCH_PANE_ID } from "../src/types/config";
import { sendRemoteControlRequest } from "../src/remote/client";
import { positiveInteger, runTmux, shellQuote, takeOption, waitForFile } from "./tui-benchmark-harness";

/**
 * Opens one ticker after another in a sandboxed TUI and checks that memory
 * levels off. The market data stores keep at most 64 unwatched entries each
 * (#945), so past that point browsing another ticker should cost nothing that
 * stays. The live heap is read after a full collection (see heap-probe.ts);
 * RSS rises and falls with the collector and cannot tell a leak from a late GC.
 */

// Qualify the same 120 US listings: bare symbols can stop at an ambiguity
// picker, leaving the stores below their cap when the plateau measurement starts.
const TICKERS = [
  "AAPL:NASDAQ", "MSFT:NASDAQ", "NVDA:NASDAQ", "AMZN:NASDAQ", "GOOGL:NASDAQ",
  "META:NASDAQ", "TSLA:NASDAQ", "AVGO:NASDAQ", "BRK.B:NYSE", "JPM:NYSE",
  "LLY:NYSE", "V:NYSE", "UNH:NYSE", "XOM:NYSE", "MA:NYSE",
  "JNJ:NYSE", "PG:NYSE", "HD:NYSE", "COST:NASDAQ", "ABBV:NYSE",
  "MRK:NYSE", "CVX:NYSE", "ORCL:NYSE", "KO:NYSE", "PEP:NASDAQ",
  "ADBE:NASDAQ", "WMT:NASDAQ", "BAC:NYSE", "CRM:NYSE", "NFLX:NASDAQ",
  "AMD:NASDAQ", "TMO:NYSE", "MCD:NYSE", "CSCO:NASDAQ", "ACN:NYSE",
  "LIN:NASDAQ", "ABT:NYSE", "INTC:NASDAQ", "DHR:NYSE", "WFC:NYSE",
  "DIS:NYSE", "TXN:NASDAQ", "PM:NYSE", "CAT:NYSE", "VZ:NYSE",
  "INTU:NASDAQ", "AMGN:NASDAQ", "IBM:NYSE", "QCOM:NASDAQ", "NEE:NYSE",
  "UNP:NYSE", "GE:NYSE", "HON:NASDAQ", "LOW:NYSE", "SPGI:NYSE",
  "AMAT:NASDAQ", "RTX:NYSE", "BA:NYSE", "GS:NYSE", "NKE:NYSE",
  "PFE:NYSE", "ISRG:NASDAQ", "T:NYSE", "BKNG:NASDAQ", "ELV:NYSE",
  "SBUX:NASDAQ", "MDT:NYSE", "BLK:NYSE", "PLD:NYSE", "DE:NYSE",
  "LMT:NYSE", "SYK:NYSE", "GILD:NASDAQ", "ADP:NASDAQ", "MDLZ:NASDAQ",
  "TJX:NYSE", "CB:NYSE", "MMC:NYSE", "ADI:NASDAQ", "VRTX:NASDAQ",
  "REGN:NASDAQ", "C:NYSE", "SCHW:NYSE", "MO:NYSE", "LRCX:NASDAQ",
  "CI:NYSE", "ZTS:NYSE", "BSX:NYSE", "SO:NYSE", "PGR:NYSE",
  "ETN:NYSE", "MU:NASDAQ", "DUK:NYSE", "BDX:NYSE", "SLB:NYSE",
  "EQIX:NASDAQ", "AON:NYSE", "ITW:NYSE", "CME:NASDAQ", "NOC:NYSE",
  "PANW:NASDAQ", "APD:NYSE", "CSX:NASDAQ", "CL:NYSE", "SNPS:NASDAQ",
  "ICE:NYSE", "SHW:NYSE", "KLAC:NASDAQ", "WM:NYSE", "MCK:NYSE",
  "FCX:NYSE", "EOG:NYSE", "CDNS:NASDAQ", "USB:NYSE", "GD:NYSE",
  "HUM:NYSE", "EMR:NYSE", "MPC:NYSE", "PNC:NYSE", "ORLY:NASDAQ",
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
    `env GLOOMBERB_HOME=${shellQuote(dataDir)} GLOOMBERB_HEAP_PROBE=${shellQuote(heapLog)} `
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
    await waitForTickerPane(symbol);
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

// ticker.navigate acknowledges the command before its asynchronous listing lookup.
// Count it only after the requested ticker actually replaces the focused pane.
async function waitForTickerPane(symbol: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await sendRemoteControlRequest(
      { type: "get", resource: "app://panes", include: ["app"] },
      { dataDir, appKind: "tui" },
    );
    if (!response.ok) throw new Error(`Could not inspect ticker pane: ${JSON.stringify(response)}`);
    const app = response.state?.app as { commandBarOpen?: boolean } | undefined;
    const panes = response.data as Array<{
      focused?: boolean;
      paneId?: string;
      placement?: string;
      binding?: { kind?: string; symbol?: string };
    }>;
    if (app?.commandBarOpen === false && panes.some((pane) =>
      pane.focused && pane.paneId === TICKER_RESEARCH_PANE_ID
      && ["docked", "floating", "detached"].includes(pane.placement ?? "")
      && pane.binding?.kind === "fixed" && pane.binding.symbol === symbol,
    )) return;
    await Bun.sleep(50);
  }
  throw new Error(`ticker.navigate ${symbol} did not open the requested listing within 15 seconds.`);
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
