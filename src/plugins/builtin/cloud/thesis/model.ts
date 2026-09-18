import type {
  CloudThesis,
  ThesisCatalyst,
  ThesisDocument,
  ThesisHealth,
  ThesisPillarStatus,
  ThesisSignal,
} from "../../../../api-client";
import type { TickerRecord } from "../../../../types/ticker";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fundamentals a metric pillar can bind to; mirrors the server list. */
export const THESIS_METRIC_KEYS: ReadonlyArray<{ key: string; label: string; unit: string }> = [
  { key: "grossMarginPct", label: "Gross margin, latest quarter", unit: "%" },
  { key: "operatingMarginPct", label: "Operating margin, latest quarter", unit: "%" },
  { key: "netMarginPct", label: "Net margin, latest quarter", unit: "%" },
  { key: "revenueGrowthYoYPct", label: "Revenue growth YoY, latest quarter", unit: "%" },
  { key: "revenueGrowthTtmPct", label: "Revenue growth, trailing 4Q vs prior 4Q", unit: "%" },
  { key: "dilutedSharesChangeYoYPct", label: "Diluted share count change YoY", unit: "%" },
  { key: "freeCashFlowTtm", label: "Free cash flow, trailing 4Q", unit: "" },
  { key: "capexTtm", label: "Capex, trailing 4Q", unit: "" },
  { key: "capexGrowthYoYPct", label: "Capex growth YoY, latest quarter", unit: "%" },
  { key: "netDebtToEbitda", label: "Net debt / EBITDA", unit: "x" },
  { key: "forwardPE", label: "Forward P/E", unit: "x" },
  { key: "trailingPE", label: "Trailing P/E", unit: "x" },
];

/** Macro series a pillar can bind to; checked against FRED, not a ticker. */
export const THESIS_SERIES_KEYS: ReadonlyArray<{ key: string; label: string; unit: string }> = [
  { key: "series:DGS10", label: "10-year Treasury yield", unit: "%" },
  { key: "series:DGS2", label: "2-year Treasury yield", unit: "%" },
  { key: "series:FEDFUNDS", label: "Fed funds rate", unit: "%" },
  { key: "series:UNRATE", label: "Unemployment rate", unit: "%" },
  { key: "series:CPIYOY", label: "CPI inflation YoY", unit: "%" },
  { key: "series:HYOAS", label: "High-yield credit spread", unit: "%" },
  { key: "series:VIX", label: "VIX", unit: "" },
  { key: "series:T10Y2Y", label: "10y minus 2y Treasury spread", unit: "%" },
];

const ALL_METRIC_KEYS = [...THESIS_METRIC_KEYS, ...THESIS_SERIES_KEYS];

export function metricLabel(key: string): string {
  return ALL_METRIC_KEYS.find((entry) => entry.key === key)?.label ?? key;
}

export function metricUnit(key: string): string {
  return ALL_METRIC_KEYS.find((entry) => entry.key === key)?.unit ?? "";
}

export function computeHealth(document: ThesisDocument): ThesisHealth {
  if (document.killConditions.some((condition) => condition.triggered)) return "broken";
  const statuses = document.pillars.map((pillar) => pillar.status);
  if (statuses.includes("broken")) return "broken";
  if (statuses.includes("weakening")) return "weakening";
  if (statuses.includes("intact")) return "intact";
  return "unverified";
}

const HEALTH_ORDER: Record<ThesisHealth, number> = { broken: 0, weakening: 1, unverified: 2, intact: 3 };

export function healthLabel(health: ThesisHealth): string {
  return health.toUpperCase();
}

export function healthTone(health: ThesisHealth): "negative" | "warning" | "neutral" | "positive" {
  switch (health) {
    case "broken": return "negative";
    case "weakening": return "warning";
    case "intact": return "positive";
    default: return "neutral";
  }
}

export function pillarGlyph(status: ThesisPillarStatus): string {
  switch (status) {
    case "intact": return "●";
    case "weakening": return "◐";
    case "broken": return "○";
    default: return "·";
  }
}

const PILLAR_STATUS_CYCLE: readonly ThesisPillarStatus[] = ["unverified", "intact", "weakening", "broken"];

export function nextPillarStatus(status: ThesisPillarStatus): ThesisPillarStatus {
  const index = PILLAR_STATUS_CYCLE.indexOf(status);
  return PILLAR_STATUS_CYCLE[(index + 1) % PILLAR_STATUS_CYCLE.length]!;
}

export type CatalystState = "pending" | "due" | "passed" | "hit" | "missed";

/** Dated expectations get louder as they approach and nag once they slip. */
export function catalystState(catalyst: ThesisCatalyst, now = Date.now()): CatalystState {
  if (catalyst.status !== "pending") return catalyst.status;
  if (!catalyst.date) return "pending";
  const days = daysUntil(catalyst.date, now);
  if (days === null) return "pending";
  if (days < 0) return "passed";
  if (days <= 14) return "due";
  return "pending";
}

export function daysUntil(date: string, now = Date.now()): number | null {
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(stamp)) return null;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return Math.round((stamp - today) / DAY_MS);
}

export function describeDays(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days}d` : `${-days}d ago`;
}

export function daysSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return null;
  return Math.floor((now - stamp) / DAY_MS);
}

/** The next dated catalyst still pending, soonest first. */
export function nextCatalyst(document: ThesisDocument, now = Date.now()): ThesisCatalyst | null {
  const today = new Date(now).toISOString().slice(0, 10);
  return [...document.catalysts]
    .filter((catalyst) => catalyst.status === "pending" && catalyst.date && catalyst.date >= today)
    .sort((a, b) => a.date!.localeCompare(b.date!))[0] ?? null;
}

/** Review is due when the cadence elapsed since the last review (or creation). */
export function reviewDue(thesis: Pick<CloudThesis, "reviewedAt" | "createdAt" | "reviewEveryDays" | "status">, now = Date.now()): boolean {
  if (thesis.status === "closed") return false;
  const since = daysSince(thesis.reviewedAt ?? thesis.createdAt, now);
  return since !== null && since >= thesis.reviewEveryDays;
}

function heldSymbols(document: ThesisDocument): string[] {
  return document.instruments.map((instrument) => instrument.symbol);
}

/** Theses that hold a symbol (core or hedge), not ones that only listen to it. */
export function thesesCovering(theses: readonly CloudThesis[], symbol: string | null): CloudThesis[] {
  if (!symbol) return [];
  const upper = symbol.toUpperCase();
  return theses.filter((thesis) => heldSymbols(thesis.document).includes(upper));
}

/** Worst health among the theses covering a symbol, for the portfolio dot. */
export function symbolHealth(theses: readonly CloudThesis[], symbol: string): ThesisHealth | null {
  const covering = thesesCovering(theses, symbol).filter((thesis) => thesis.status !== "closed");
  if (covering.length === 0) return null;
  return covering.map((thesis) => thesis.health).sort((a, b) => HEALTH_ORDER[a] - HEALTH_ORDER[b])[0]!;
}

export type ThesisAttention = "signals" | "broken" | "weakening" | "review" | "catalyst" | null;

/** The one reason a thesis sits at the top of the board, if any. */
export function attentionReason(thesis: CloudThesis, now = Date.now()): ThesisAttention {
  if (thesis.status === "closed") return null;
  if (thesis.openSignals > 0) return "signals";
  if (thesis.health === "broken") return "broken";
  if (thesis.health === "weakening") return "weakening";
  if (reviewDue(thesis, now)) return "review";
  if (thesis.document.catalysts.some((catalyst) => catalystState(catalyst, now) === "passed")) return "catalyst";
  return null;
}

export function describeAttention(reason: ThesisAttention, thesis: CloudThesis): string {
  switch (reason) {
    case "signals": return `${thesis.openSignals} to rule on`;
    case "broken": return "kill condition fired";
    case "weakening": return "pillar weakening";
    case "review": return "review due";
    case "catalyst": return "catalyst slipped";
    default: return "";
  }
}

export type BoardGroup = "attention" | "active" | "watching" | "closed";

export function boardGroup(thesis: CloudThesis, now = Date.now()): BoardGroup {
  if (thesis.status === "closed") return "closed";
  if (attentionReason(thesis, now)) return "attention";
  return thesis.status === "watching" ? "watching" : "active";
}

const GROUP_ORDER: Record<BoardGroup, number> = { attention: 0, active: 1, watching: 2, closed: 3 };

export function sortForBoard(theses: readonly CloudThesis[], now = Date.now()): CloudThesis[] {
  return [...theses].sort((a, b) => {
    const group = GROUP_ORDER[boardGroup(a, now)] - GROUP_ORDER[boardGroup(b, now)];
    if (group !== 0) return group;
    const health = HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health];
    if (health !== 0) return health;
    if (b.openSignals !== a.openSignals) return b.openSignals - a.openSignals;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function groupLabel(group: BoardGroup): string {
  switch (group) {
    case "attention": return "Needs attention";
    case "active": return "Active";
    case "watching": return "Watching";
    case "closed": return "Closed";
  }
}

// Portfolio integration

export interface SymbolExposure {
  symbol: string;
  /** Market value in the base currency; NaN when a quote is missing. */
  value: number;
  /** Option contracts are held against the underlying; their notional is an upper bound on exposure. */
  optionNotional: number;
  hasOptions: boolean;
}

export interface ThesisExposure {
  thesis: CloudThesis;
  /** Sum of held instrument values (hedges subtracted), base currency. */
  value: number;
  weight: number;
  hasOptions: boolean;
  missingQuotes: boolean;
}

export function thesisExposure(
  thesis: CloudThesis,
  exposureBySymbol: ReadonlyMap<string, SymbolExposure>,
  bookValue: number,
): ThesisExposure {
  let value = 0;
  let hasOptions = false;
  let missingQuotes = false;
  for (const instrument of thesis.document.instruments) {
    const exposure = exposureBySymbol.get(instrument.symbol);
    if (!exposure) continue;
    if (!Number.isFinite(exposure.value)) {
      missingQuotes = true;
      continue;
    }
    hasOptions ||= exposure.hasOptions;
    value += instrument.role === "hedge" ? -Math.abs(exposure.value) : exposure.value;
  }
  return {
    thesis,
    value,
    weight: bookValue > 0 ? Math.abs(value) / bookValue : 0,
    hasOptions,
    missingQuotes,
  };
}

/** Share of the book sitting on theses that are weakening or broken. */
export function bookAtRisk(exposures: readonly ThesisExposure[]): number {
  return exposures
    .filter((entry) => entry.thesis.status !== "closed" && (entry.thesis.health === "weakening" || entry.thesis.health === "broken"))
    .reduce((total, entry) => total + entry.weight, 0);
}

export interface ConvictionRow {
  thesis: CloudThesis;
  conviction: number;
  weight: number;
  value: number;
  /** Conviction rank minus weight rank; positive means under-sized for the conviction. */
  gap: number;
  hasOptions: boolean;
}

/**
 * Ranks conviction against actual weight so the two kinds of mismatch stand
 * out: high conviction sized small, and low conviction that grew big.
 */
export function convictionRows(exposures: readonly ThesisExposure[]): ConvictionRow[] {
  const open = exposures.filter((entry) => entry.thesis.status === "active" && entry.weight > 0);
  const byConviction = [...open].sort((a, b) => b.thesis.conviction - a.thesis.conviction);
  const byWeight = [...open].sort((a, b) => b.weight - a.weight);
  const convictionRank = new Map(byConviction.map((entry, index) => [entry.thesis.id, index]));
  const weightRank = new Map(byWeight.map((entry, index) => [entry.thesis.id, index]));
  return open
    .map((entry) => ({
      thesis: entry.thesis,
      conviction: entry.thesis.conviction,
      weight: entry.weight,
      value: entry.value,
      gap: (weightRank.get(entry.thesis.id) ?? 0) - (convictionRank.get(entry.thesis.id) ?? 0),
      hasOptions: entry.hasOptions,
    }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || b.weight - a.weight);
}

export interface UntrackedRow {
  symbol: string;
  name: string | null;
  /** Share of the book in scope; 0 when unpriced or a watchlist. */
  weight: number;
  held: boolean;
}

/**
 * Symbols in scope that no open thesis holds, biggest position first so
 * the untracked money is what you see, then alphabetical.
 */
export function untrackedRows(
  tickers: readonly TickerRecord[],
  theses: readonly CloudThesis[],
  exposureBySymbol: ReadonlyMap<string, SymbolExposure>,
  bookValue: number,
  nameOf: (symbol: string) => string | null = () => null,
): UntrackedRow[] {
  const covered = new Set(
    theses.filter((thesis) => thesis.status !== "closed").flatMap((thesis) => heldSymbols(thesis.document)),
  );
  return tickers
    .map((ticker) => ticker.metadata.ticker)
    .filter((symbol) => !covered.has(symbol.toUpperCase()))
    .map((symbol): UntrackedRow => {
      const exposure = exposureBySymbol.get(symbol.toUpperCase());
      const value = exposure && Number.isFinite(exposure.value) ? Math.abs(exposure.value) : 0;
      return {
        symbol,
        name: nameOf(symbol),
        weight: bookValue > 0 ? value / bookValue : 0,
        held: tickers.find((ticker) => ticker.metadata.ticker === symbol)?.metadata.positions.some((position) => position.shares !== 0) ?? false,
      };
    })
    .sort((a, b) => b.weight - a.weight || a.symbol.localeCompare(b.symbol));
}

/** Theses that hold at least one of the symbols in scope. */
export function thesesInScope(theses: readonly CloudThesis[], symbols: ReadonlySet<string> | null): CloudThesis[] {
  if (!symbols) return [...theses];
  return theses.filter((thesis) => heldSymbols(thesis.document).some((symbol) => symbols.has(symbol)));
}

/** "NVDA, AMD" or "nvda amd" into distinct upper-case symbols, in order. */
export function parseSymbolList(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const symbol = raw.trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

/** The names of the core instruments, for a board row next to the title. */
export function thesisNames(thesis: CloudThesis, nameOf: (symbol: string) => string | null): string {
  const core = thesis.document.instruments.filter((entry) => entry.role === "core");
  const named = (core.length ? core : thesis.document.instruments)
    .map((entry) => nameOf(entry.symbol))
    .filter((name): name is string => !!name);
  return named.join(", ");
}

export function openSignals(signals: readonly ThesisSignal[]): ThesisSignal[] {
  return signals.filter((signal) => signal.status === "open");
}

export function latestReviewSummary(signals: readonly ThesisSignal[]): ThesisSignal | null {
  return signals.find((signal) => signal.targetKind === "thesis" && signal.source?.kind === "review") ?? null;
}

export function signalTargetText(document: ThesisDocument, signal: ThesisSignal): string {
  if (signal.targetKind === "pillar") return document.pillars.find((entry) => entry.id === signal.targetId)?.text ?? "pillar";
  if (signal.targetKind === "kill") return document.killConditions.find((entry) => entry.id === signal.targetId)?.text ?? "kill condition";
  if (signal.targetKind === "catalyst") return document.catalysts.find((entry) => entry.id === signal.targetId)?.text ?? "catalyst";
  return "thesis";
}

export function verdictTone(verdict: ThesisSignal["verdict"]): "negative" | "warning" | "positive" | "neutral" {
  switch (verdict) {
    case "breaks": return "negative";
    case "challenges": return "warning";
    case "supports": return "positive";
    default: return "neutral";
  }
}

export function itemId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function emptyDocument(instruments: ReadonlyArray<{ symbol: string; exchange?: string; side?: "long" | "short" }>): ThesisDocument {
  return {
    summary: "",
    instruments: instruments.map((entry) => ({
      symbol: entry.symbol.toUpperCase(),
      ...(entry.exchange ? { exchange: entry.exchange } : {}),
      side: entry.side ?? "long",
      role: "core" as const,
    })),
    evidence: { symbols: [], keywords: [] },
    pillars: [],
    killConditions: [],
    catalysts: [],
  };
}
