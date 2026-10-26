import {
  LIVE_SCAN_INDEXES,
  LIVE_SCAN_WINDOWS,
  type LiveScanCondition,
  type LiveScanDirection,
  type LiveScanIndex,
  type LiveScanMatch,
  type LiveScanWindow,
  type LiveScanWireDefinition,
} from "../../../api-client/live-scan";
import type { TickerRecord } from "../../../types/ticker";
import { canonicalExchange, isUsListingExchange } from "../../../utils/exchanges";

/**
 * SCAN's own model: the scan a pane runs, as it keeps it in pane state, and
 * the definition Gloom Cloud evaluates. A watchlist is kept by id and sent as
 * its symbols, read when the scan runs, so an edit to the list moves the scan.
 */
export type LiveScanUniverse =
  | { kind: "all" }
  | { kind: "index"; index: LiveScanIndex }
  | { kind: "sector"; sector: string }
  | { kind: "watchlist"; id: string };

export interface LiveScan {
  universe: LiveScanUniverse;
  /** Every condition must hold. */
  conditions: LiveScanCondition[];
  minPrice: number | null;
  minMarketCap: number | null;
  /** The session's volume so far. */
  minVolume: number | null;
}

export interface SavedLiveScan {
  id: string;
  name: string;
  scan: LiveScan;
}

export const LIVE_SCAN_MAX_CONDITIONS = 8;
/** The most symbols a watchlist universe sends; the server refuses more. */
const LIVE_SCAN_MAX_SYMBOLS = 1_000;
export const LIVE_SCAN_MAX_SAVED = 50;

const INDEX_LABELS: Record<LiveScanIndex, string> = {
  sp500: "S&P 500",
  sp400: "S&P MidCap 400",
  sp600: "S&P SmallCap 600",
  russell1000: "Russell 1000",
  russell2000: "Russell 2000",
};

/** The sectors the stored screener files US stocks under. */
export const LIVE_SCAN_SECTORS = [
  "Basic Materials",
  "Communication Services",
  "Consumer Cyclical",
  "Consumer Defensive",
  "Energy",
  "Financial Services",
  "Healthcare",
  "Industrials",
  "Real Estate",
  "Technology",
  "Utilities",
] as const;

/** Moving on volume: what most intraday scans start from. */
export const DEFAULT_LIVE_SCAN: LiveScan = {
  universe: { kind: "all" },
  conditions: [
    { kind: "move", window: 5, direction: "either", percent: 1 },
    { kind: "volume_spike", window: 5, ratio: 2 },
  ],
  minPrice: 5,
  minMarketCap: 300e6,
  minVolume: null,
};

export const MIN_PRICE_OPTIONS = [
  { value: "off", label: "Any" },
  { value: "1", label: "$1" },
  { value: "5", label: "$5" },
  { value: "10", label: "$10" },
  { value: "20", label: "$20" },
] as const;
export const MIN_CAP_OPTIONS = [
  { value: "off", label: "Any" },
  { value: "300000000", label: "$300M" },
  { value: "2000000000", label: "$2B" },
  { value: "10000000000", label: "$10B" },
  { value: "200000000000", label: "$200B" },
] as const;
export const MIN_VOLUME_OPTIONS = [
  { value: "off", label: "Any" },
  { value: "100000", label: "100K" },
  { value: "500000", label: "500K" },
  { value: "1000000", label: "1M" },
  { value: "5000000", label: "5M" },
] as const;

export const floorValue = (value: number | null) => (value == null ? "off" : String(value));
export const parseFloorValue = (value: string) => (value === "off" ? null : Number(value));

/** A universe as one select value: `all`, `index:sp500`, `sector:Energy`, `watch:<id>`. */
export function universeValue(universe: LiveScanUniverse): string {
  switch (universe.kind) {
    case "all":
      return "all";
    case "index":
      return `index:${universe.index}`;
    case "sector":
      return `sector:${universe.sector}`;
    case "watchlist":
      return `watch:${universe.id}`;
  }
}

export function parseUniverseValue(value: string): LiveScanUniverse {
  const [kind, ...rest] = value.split(":");
  const arg = rest.join(":");
  if (kind === "index" && (LIVE_SCAN_INDEXES as readonly string[]).includes(arg)) return { kind: "index", index: arg as LiveScanIndex };
  if (kind === "sector" && arg) return { kind: "sector", sector: arg };
  if (kind === "watch" && arg) return { kind: "watchlist", id: arg };
  return { kind: "all" };
}

export function universeOptions(watchlists: ReadonlyArray<{ id: string; name: string }>): Array<{ value: string; label: string }> {
  return [
    { value: "all", label: "All US stocks" },
    ...LIVE_SCAN_INDEXES.map((index) => ({ value: `index:${index}`, label: INDEX_LABELS[index] })),
    ...LIVE_SCAN_SECTORS.map((sector) => ({ value: `sector:${sector}`, label: sector })),
    ...watchlists.map((list) => ({ value: `watch:${list.id}`, label: `Watchlist · ${list.name}` })),
  ];
}

export function universeLabel(universe: LiveScanUniverse, watchlists: ReadonlyArray<{ id: string; name: string }>): string {
  switch (universe.kind) {
    case "all":
      return "All US stocks";
    case "index":
      return INDEX_LABELS[universe.index];
    case "sector":
      return universe.sector;
    case "watchlist":
      return `Watchlist · ${watchlists.find((list) => list.id === universe.id)?.name ?? "removed"}`;
  }
}

const windowText = (window: LiveScanWindow) => `${window} min`;

/** A condition in words, as the Conditions tab lists it and an alert names it. */
export function conditionText(condition: LiveScanCondition): string {
  switch (condition.kind) {
    case "move": {
      const verb = condition.direction === "up" ? "Up" : condition.direction === "down" ? "Down" : "Moved";
      return `${verb} ${condition.percent}% or more in ${windowText(condition.window)}`;
    }
    case "volume_spike":
      return condition.window === "day"
        ? `Volume ${condition.ratio}x the average pace today`
        : `Volume ${condition.ratio}x average in ${windowText(condition.window)}`;
    case "new_high":
      return `New session high in the last ${windowText(condition.within)}`;
    case "new_low":
      return `New session low in the last ${windowText(condition.within)}`;
    case "vwap_cross": {
      const side = condition.direction === "either" ? "" : ` ${condition.direction}`;
      return `Crossed${side} VWAP in the last ${windowText(condition.within)}`;
    }
    case "gap": {
      const verb = condition.direction === "up" ? "Gapped up" : condition.direction === "down" ? "Gapped down" : "Gapped";
      return `${verb} ${condition.percent}% or more`;
    }
  }
}

/** The column a condition's figure reads in, named short enough for the header. */
export function conditionColumnLabel(condition: LiveScanCondition): string {
  switch (condition.kind) {
    case "move":
      return `${condition.window}M CHG`;
    case "volume_spike":
      return condition.window === "day" ? "RVOL" : `VOL ${condition.window}M`;
    case "new_high":
      return "NEW HIGH";
    case "new_low":
      return "NEW LOW";
    case "vwap_cross":
      return "VWAP CROSS";
    case "gap":
      return "GAP";
  }
}

/** What a condition's figure means: a percent, a multiple of average volume, or the time of an event. */
export function conditionUnit(condition: LiveScanCondition): "percent" | "multiple" | "time" {
  return condition.kind === "move" || condition.kind === "gap"
    ? "percent"
    : condition.kind === "volume_spike"
      ? "multiple"
      : "time";
}

export function formatMultiple(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return value >= 10 ? `${Math.round(value)}x` : `${value.toFixed(1)}x`;
}

/** A time of day the scanner saw something, to the second. */
export function formatScanTime(at: number | null | undefined): string {
  if (at == null || !Number.isFinite(at)) return "--";
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The plain symbol a watchlist row stands for as a US stock, or null when it is not one. */
function usStockSymbol(record: Pick<TickerRecord, "metadata">): string | null {
  const { ticker, exchange, assetCategory } = record.metadata;
  const category = assetCategory?.toUpperCase();
  if (category && !["STK", "STOCK", "EQUITY", "ETF", "FUND", "COMMON"].includes(category)) return null;
  const venue = canonicalExchange(exchange);
  if (venue && !isUsListingExchange(venue)) return null;
  const symbol = ticker.trim().toUpperCase();
  // A suffixed, quoted or index symbol (RIO.L, ^GSPC, BTC-USD, ES=F) is not a US stock.
  if (!/^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z])?$/.test(symbol)) return null;
  return symbol.replace(/-([A-Z])$/, ".$1");
}

export interface WireScan {
  definition: LiveScanWireDefinition;
  /** Watchlist rows that are not US stocks, left out of the scan. */
  skipped: string[];
  /** Set when the scan cannot run as it is, such as an empty or deleted watchlist. */
  problem: string | null;
}

/** The definition Gloom Cloud evaluates, with a watchlist read into its US symbols. */
export function toWireScan(scan: LiveScan, tickers: Iterable<TickerRecord>): WireScan {
  const floors = {
    ...(scan.minPrice != null ? { minPrice: scan.minPrice } : {}),
    ...(scan.minMarketCap != null ? { minMarketCap: scan.minMarketCap } : {}),
    ...(scan.minVolume != null ? { minVolume: scan.minVolume } : {}),
  };
  const base = { version: 1 as const, conditions: scan.conditions, ...floors };
  if (scan.universe.kind !== "watchlist") {
    return { definition: { ...base, universe: scan.universe }, skipped: [], problem: null };
  }
  const listId = scan.universe.id;
  const symbols: string[] = [];
  const skipped: string[] = [];
  for (const record of tickers) {
    if (!record.metadata.watchlists.includes(listId)) continue;
    const symbol = usStockSymbol(record);
    if (symbol) symbols.push(symbol);
    else skipped.push(record.metadata.ticker);
  }
  const unique = [...new Set(symbols)].sort();
  const problem = unique.length === 0
    ? skipped.length
      ? "This watchlist has no US stocks to scan."
      : "This watchlist is empty."
    : unique.length > LIVE_SCAN_MAX_SYMBOLS
      ? `Only the first ${LIVE_SCAN_MAX_SYMBOLS.toLocaleString("en-US")} symbols of this watchlist are scanned.`
      : null;
  return {
    definition: { ...base, universe: { kind: "symbols", symbols: unique.slice(0, LIVE_SCAN_MAX_SYMBOLS) } },
    skipped,
    problem,
  };
}

/** Same scan, same key: what the tracking of matches and alerts is kept against. */
export function liveScanKey(definition: LiveScanWireDefinition): string {
  return JSON.stringify(definition);
}

// Pane state is read back from disk and from other devices' layouts, so every
// field is checked; anything that does not read falls back rather than throws.

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isWindow = (value: unknown): value is LiveScanWindow => (LIVE_SCAN_WINDOWS as readonly unknown[]).includes(value);
const isDirection = (value: unknown): value is LiveScanDirection => value === "up" || value === "down" || value === "either";
const isAmount = (value: unknown, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;

function readUniverse(value: unknown): LiveScanUniverse {
  if (!isObject(value)) return { kind: "all" };
  if (value.kind === "index" && (LIVE_SCAN_INDEXES as readonly unknown[]).includes(value.index)) return { kind: "index", index: value.index as LiveScanIndex };
  if (value.kind === "sector" && typeof value.sector === "string" && value.sector.trim()) return { kind: "sector", sector: value.sector.trim() };
  if (value.kind === "watchlist" && typeof value.id === "string" && value.id) return { kind: "watchlist", id: value.id };
  return { kind: "all" };
}

export function readCondition(value: unknown): LiveScanCondition | null {
  if (!isObject(value)) return null;
  switch (value.kind) {
    case "move":
      return isWindow(value.window) && isDirection(value.direction) && isAmount(value.percent, 1_000)
        ? { kind: "move", window: value.window, direction: value.direction, percent: value.percent }
        : null;
    case "volume_spike":
      return (value.window === "day" || isWindow(value.window)) && isAmount(value.ratio, 1_000) && value.ratio >= 0.1
        ? { kind: "volume_spike", window: value.window, ratio: value.ratio }
        : null;
    case "new_high":
    case "new_low":
      return isWindow(value.within) ? { kind: value.kind, within: value.within } : null;
    case "vwap_cross":
      return isWindow(value.within) && (value.direction === "above" || value.direction === "below" || value.direction === "either")
        ? { kind: "vwap_cross", direction: value.direction, within: value.within }
        : null;
    case "gap":
      return isDirection(value.direction) && isAmount(value.percent, 1_000)
        ? { kind: "gap", direction: value.direction, percent: value.percent }
        : null;
    default:
      return null;
  }
}

const readFloor = (value: unknown, max: number) => (isAmount(value, max) && value > 0 ? value : null);

export function readLiveScan(value: unknown): LiveScan {
  if (!isObject(value)) return DEFAULT_LIVE_SCAN;
  return {
    universe: readUniverse(value.universe),
    conditions: Array.isArray(value.conditions)
      ? value.conditions.map(readCondition).filter((condition): condition is LiveScanCondition => !!condition).slice(0, LIVE_SCAN_MAX_CONDITIONS)
      : [],
    minPrice: readFloor(value.minPrice, 100_000),
    minMarketCap: readFloor(value.minMarketCap, 1e13),
    minVolume: readFloor(value.minVolume, 1e11),
  };
}

export function readSavedLiveScans(value: unknown): SavedLiveScan[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (
    isObject(entry) && typeof entry.id === "string" && entry.id && typeof entry.name === "string" && entry.name.trim()
      ? [{ id: entry.id, name: entry.name.trim(), scan: readLiveScan(entry.scan) }]
      : []
  )).slice(0, LIVE_SCAN_MAX_SAVED);
}

/** A match's figure for one condition, as its column shows it. */
export function matchValue(match: LiveScanMatch, index: number): number | null {
  const value = match.values[index];
  return value == null || !Number.isFinite(value) ? null : value;
}
