/**
 * What importing a broker's positions export into a manual portfolio does,
 * worked out before anything is saved, so the CLI and the app can show it
 * first: each position the file holds with the listing its symbol resolved
 * to, what is skipped and why, and in replace mode the holdings that go.
 * Applying the plan sets each position as `portfolio position set` does.
 */
import type { AppConfig } from "../../types/config";
import type { Portfolio, TickerRecord } from "../../types/ticker";
import { getManualPortfolioPositionPrefill } from "../manual-lots";
import {
  adoptFirstPositionCurrency,
  clearPortfolioTargetWeights,
  hasOpenPortfolioPositions,
  LotCostFxMergeError,
  removeTickerFromPortfolio,
  resolveManualPositionCurrency,
  setManualPortfolioPosition,
  type SetManualPortfolioPositionInput,
} from "../mutations";
import type { FilePosition, PositionsFile, PositionsLayoutId, SkippedFileRow } from "./parse";

/** Merge keeps the holdings the file does not list; replace removes them. */
export type PositionsImportMode = "merge" | "replace";

/** A file symbol's listing, or why it has none. */
export type ImportSymbolResolution = { ticker: TickerRecord; notes?: readonly string[] } | { error: string };

export interface PositionsImportRow {
  /** The file's symbols that became this listing (BRK.B and BRK-B are one). */
  symbols: string[];
  /** The listing as resolved, before the import changes it. */
  ticker: TickerRecord;
  /** Signed: a negative count is a short. */
  shares: number;
  /** Per share in `currency`; null when neither the file nor the holding gives one. */
  avgCost: number | null;
  currency: string;
  dateAcquired: string | null;
  /** What the portfolio held of the listing before: its shares, 0 for a listing without a position, null when not held. */
  heldShares: number | null;
  /** The file gives no cost, so the holding's own is kept. */
  keptCost: boolean;
  /** What resolving the symbol said, such as the venue a bare symbol went to. */
  notes: string[];
  lines: number[];
}

export interface PositionsImportPlan {
  layout: PositionsLayoutId;
  mode: PositionsImportMode;
  rows: PositionsImportRow[];
  skipped: SkippedFileRow[];
  /** Replace: the holdings the file does not list, removed with their targets. */
  removed: TickerRecord[];
}

/** One listing from several of the file's symbols: as the file's own rows of one symbol are added up. */
function combine(positions: readonly FilePosition[]): FilePosition | { reason: string } {
  if (positions.length === 1) return positions[0]!;
  const currencies = new Set(positions.map((position) => position.currency ?? ""));
  if (currencies.size > 1) return { reason: `the same listing in different currencies (${[...currencies].map((code) => code || "none").join(", ")})` };
  const shares = Number(positions.reduce((sum, position) => sum + position.shares, 0).toPrecision(15));
  if (shares === 0) return { reason: "rows net to zero shares" };
  const held = positions.reduce((sum, position) => sum + Math.abs(position.shares), 0);
  const avgCost = positions.every((position) => position.avgCost !== null)
    ? Number((positions.reduce((sum, position) => sum + position.avgCost! * Math.abs(position.shares), 0) / held).toPrecision(15))
    : null;
  const dates = positions.map((position) => position.dateAcquired).filter((date): date is string => !!date).sort();
  return {
    symbol: positions[0]!.symbol,
    description: positions.find((position) => position.description)?.description ?? null,
    shares,
    avgCost,
    currency: positions[0]!.currency,
    dateAcquired: dates[0] ?? null,
    lines: positions.flatMap((position) => position.lines).sort((left, right) => left - right),
  };
}

function heldShares(ticker: TickerRecord | undefined, portfolioId: string): number | null {
  if (!ticker?.metadata.portfolios.includes(portfolioId)) return null;
  return ticker.metadata.positions
    .filter((position) => position.portfolio === portfolioId)
    .reduce((sum, position) => sum + (position.side === "short" && position.shares > 0 ? -position.shares : position.shares), 0);
}

/**
 * The import, worked out: `resolutions` maps each of the file's symbols to
 * its listing, `holdings` are the portfolio's tickers as they are now.
 */
export function buildPositionsImportPlan({
  file,
  resolutions,
  portfolio,
  holdings,
  mode,
  baseCurrency,
}: {
  file: PositionsFile;
  resolutions: ReadonlyMap<string, ImportSymbolResolution>;
  portfolio: Portfolio;
  holdings: readonly TickerRecord[];
  mode: PositionsImportMode;
  baseCurrency?: string;
}): PositionsImportPlan {
  const skipped: SkippedFileRow[] = [...file.skipped];
  const groups = new Map<string, { ticker: TickerRecord; positions: FilePosition[]; notes: string[] }>();
  for (const position of file.positions) {
    const resolution = resolutions.get(position.symbol);
    if (!resolution || "error" in resolution) {
      skipped.push({ line: position.lines[0]!, label: position.symbol, reason: resolution?.error ?? "not looked up" });
      continue;
    }
    const key = resolution.ticker.metadata.ticker;
    const group = groups.get(key) ?? { ticker: resolution.ticker, positions: [], notes: [] };
    group.positions.push(position);
    for (const note of resolution.notes ?? []) if (!group.notes.includes(note)) group.notes.push(note);
    groups.set(key, group);
  }
  const held = new Map(holdings.map((ticker) => [ticker.metadata.ticker, ticker] as const));
  const rows: PositionsImportRow[] = [];
  for (const [key, group] of groups) {
    const combined = combine(group.positions);
    if ("reason" in combined) {
      for (const position of group.positions) skipped.push({ line: position.lines[0]!, label: position.symbol, reason: combined.reason });
      continue;
    }
    const holding = held.get(key);
    // A file without costs (Vanguard's) leaves a holding's own cost as it was.
    const kept = combined.avgCost === null && holding ? getManualPortfolioPositionPrefill(holding, portfolio.id).position : null;
    const keptCost = kept && typeof kept.avgCost === "number" && Number.isFinite(kept.avgCost) ? kept : null;
    rows.push({
      symbols: group.positions.map((position) => position.symbol),
      ticker: holding ?? group.ticker,
      shares: combined.shares,
      avgCost: keptCost ? keptCost.avgCost! : combined.avgCost,
      currency: keptCost?.currency
        ? keptCost.currency
        : resolveManualPositionCurrency(combined.currency ?? undefined, group.ticker, portfolio, baseCurrency),
      dateAcquired: combined.dateAcquired,
      heldShares: heldShares(holding, portfolio.id),
      keptCost: !!keptCost,
      notes: group.notes,
      lines: combined.lines,
    });
  }
  skipped.sort((left, right) => left.line - right.line);
  const imported = new Set(rows.map((row) => row.ticker.metadata.ticker));
  const removed = mode === "replace" ? holdings.filter((ticker) => !imported.has(ticker.metadata.ticker)) : [];
  return { layout: file.layout, mode, rows, skipped, removed };
}

function setPosition(ticker: TickerRecord, portfolioId: string, input: SetManualPortfolioPositionInput): TickerRecord {
  try {
    return setManualPortfolioPosition(ticker, portfolioId, input).ticker;
  } catch (error) {
    // Lots bought at FX rates one position cannot keep: the file's position starts without a rate, as a new one does.
    if (error instanceof LotCostFxMergeError) return setManualPortfolioPosition(ticker, portfolioId, { ...input, costFx: null }).ticker;
    throw error;
  }
}

/**
 * The tickers to save and the config, when it changes: each row's position
 * set (a dated one starts from its date's FX close, not a rate it had), the
 * removed holdings and their targets gone, and an empty portfolio taking its
 * first position's currency. `current` rereads a ticker as it is now.
 */
export function applyPositionsImportPlan(
  plan: PositionsImportPlan,
  { portfolioId, config, holdings, current }: {
    portfolioId: string;
    config: AppConfig;
    holdings: readonly TickerRecord[];
    current: (key: string) => TickerRecord | null | undefined;
  },
): { tickers: TickerRecord[]; config: AppConfig | null } {
  const empty = !hasOpenPortfolioPositions(portfolioId, holdings);
  const tickers: TickerRecord[] = [];
  for (const row of plan.rows) {
    const ticker = current(row.ticker.metadata.ticker) ?? row.ticker;
    tickers.push(setPosition(ticker, portfolioId, {
      shares: row.shares,
      avgCost: row.avgCost,
      currency: row.currency,
      ...(row.dateAcquired ? { dateAcquired: row.dateAcquired, costFx: null } : {}),
    }));
  }
  let next = config;
  for (const holding of plan.removed) {
    const result = removeTickerFromPortfolio(current(holding.metadata.ticker) ?? holding, portfolioId);
    if (result.changed) tickers.push(result.ticker);
    next = clearPortfolioTargetWeights(next, portfolioId, holding.metadata.ticker).config;
  }
  const first = plan.rows[0];
  if (empty && first) next = adoptFirstPositionCurrency(next, portfolioId, first.currency) ?? next;
  return { tickers, config: next === config ? null : next };
}

/** How many rows the plan imports, updates and removes, for the line that sums it up. */
export function summarizePositionsImport(plan: PositionsImportPlan): { added: number; updated: number; removed: number; skipped: number; withoutCost: number } {
  return {
    added: plan.rows.filter((row) => row.heldShares === null).length,
    updated: plan.rows.filter((row) => row.heldShares !== null).length,
    removed: plan.removed.length,
    skipped: plan.skipped.length,
    withoutCost: plan.rows.filter((row) => row.avgCost === null).length,
  };
}
