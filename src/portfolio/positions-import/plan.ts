/**
 * What importing a broker's positions export into a manual portfolio does,
 * worked out before anything is saved, so the CLI and the app can show it
 * first: each position the file holds with the listing its symbol resolved
 * to, what is skipped and why, and in replace mode the holdings that go.
 * Applying the plan sets each position as `portfolio position set` does.
 *
 * A replace removes only holdings the file does not name. One whose symbol
 * the file lists on a row it could not import stays, and a replace is
 * refused while any of the file's stock or fund rows failed to import, since
 * the portfolio would not then hold what the file does.
 */
import type { AppConfig } from "../../types/config";
import type { Portfolio, TickerRecord } from "../../types/ticker";
import { canonicalExchange, isUsEquityExchange } from "../../utils/exchanges";
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
import { isUsBrokerLayout, type FilePosition, type PositionsFile, type PositionsLayoutId, type SkipKind, type SkippedFileRow } from "./parse";

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
  /** The holding's lots before, which the import makes one position; 0 when not held. */
  heldLots: number;
  /** The holding's cost per share before, when it had one. */
  heldAvgCost: number | null;
  heldDate: string | null;
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
  /** Replace: holdings the file names on a row it skipped, which stay as they are. */
  kept: TickerRecord[];
  /** Rows of stocks and funds that could not be imported: while there are any, a replace is refused. */
  replaceBlockers: SkippedFileRow[];
}

/**
 * Rows a replace can leave behind: what the file holds that a portfolio
 * does not (cash, options, bonds, pending activity, a plan fund with no
 * ticker) and positions it holds none of.
 */
const REPLACE_SAFE_SKIPS: ReadonlySet<SkipKind> = new Set(["cash", "pending", "option", "bond", "noTicker", "zero", "netZero"]);

/**
 * The spellings a symbol could match a holding by: BRK.B, BRK/B, BRK B and
 * BRK-B are one, and a listing suffix (ASML.AS) or venue (ASML:AMS) may be
 * left off. Matching too much only keeps a holding a replace would remove.
 */
function symbolKeys(symbol: string): string[] {
  const bare = symbol.trim().toUpperCase().split(":")[0] ?? "";
  const squash = (text: string) => text.replace(/[^A-Z0-9]/g, "");
  const keys = new Set([squash(bare)]);
  const root = bare.search(/[.\s/-]/);
  if (root > 0) keys.add(squash(bare.slice(0, root)));
  keys.delete("");
  return [...keys];
}

/** A cost the holding had, read again from a file: the same unless it moved past rounding. */
export function sameCost(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

/** One listing from several of the file's symbols: as the file's own rows of one symbol are added up. */
function combine(positions: readonly FilePosition[]): FilePosition | { kind: SkipKind; reason: string } {
  if (positions.length === 1) return positions[0]!;
  const currencies = new Set(positions.map((position) => position.currency ?? ""));
  if (currencies.size > 1) {
    return { kind: "currencies", reason: `the same listing in different currencies (${[...currencies].map((code) => code || "none").join(", ")})` };
  }
  const shares = Number(positions.reduce((sum, position) => sum + position.shares, 0).toPrecision(15));
  if (shares === 0) return { kind: "netZero", reason: "rows net to zero shares" };
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
      skipped.push({ line: position.lines[0]!, label: position.symbol, reason: resolution?.error ?? "not looked up", kind: "lookup", symbol: position.symbol });
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
      for (const position of group.positions) {
        skipped.push({ line: position.lines[0]!, label: position.symbol, reason: combined.reason, kind: combined.kind, symbol: position.symbol });
      }
      continue;
    }
    const holding = held.get(key);
    const prefill = holding ? getManualPortfolioPositionPrefill(holding, portfolio.id) : null;
    const before = prefill?.position ?? null;
    const heldCost = before && typeof before.avgCost === "number" && Number.isFinite(before.avgCost) ? before.avgCost : null;
    // A file without costs (Vanguard's) leaves a holding's own cost as it was.
    const keptCost = combined.avgCost === null && heldCost !== null ? before : null;
    const notes = [...group.notes];
    const exchange = canonicalExchange(group.ticker.metadata.exchange);
    // A US account's symbol on another market is a different line of the company, or another company.
    if (isUsBrokerLayout(file.layout) && exchange && !isUsEquityExchange(exchange)) {
      notes.push(`listed on ${exchange}, not in the US; check it is the one the account holds`);
    }
    if (prefill && prefill.lotCount > 1) notes.push(`its ${prefill.lotCount} lots become one position`);
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
      heldLots: prefill?.lotCount ?? 0,
      heldAvgCost: heldCost,
      heldDate: before?.dateAcquired ?? null,
      keptCost: !!keptCost,
      notes,
      lines: combined.lines,
    });
  }
  skipped.sort((left, right) => left.line - right.line);
  const imported = new Set(rows.map((row) => row.ticker.metadata.ticker));
  const named = new Set(skipped.flatMap((row) => row.symbol ? symbolKeys(row.symbol) : []));
  const unlisted = mode === "replace" ? holdings.filter((ticker) => !imported.has(ticker.metadata.ticker)) : [];
  const kept = unlisted.filter((ticker) => symbolKeys(ticker.metadata.ticker).some((key) => named.has(key)));
  return {
    layout: file.layout,
    mode,
    rows,
    skipped,
    removed: unlisted.filter((ticker) => !kept.includes(ticker)),
    kept,
    replaceBlockers: skipped.filter((row) => !REPLACE_SAFE_SKIPS.has(row.kind)),
  };
}

/**
 * Why a replace is refused, or null when it can go ahead: the rows that would
 * leave the portfolio short of the file. `merge` says how to merge instead.
 */
export function replaceRefusal(plan: PositionsImportPlan, merge = "Merge instead"): string | null {
  const rows = plan.replaceBlockers;
  if (rows.length === 0) return null;
  const labels = [...new Set(rows.map((row) => row.label))];
  const named = labels.length > 6 ? `${labels.slice(0, 5).join(", ")} and ${labels.length - 5} more` : labels.join(", ");
  const count = rows.length === 1 ? "1 of the file's positions" : `${rows.length} of the file's positions`;
  return `Replace needs every position in the file, and ${count} could not be imported (${named}). ${merge}, or fix ${rows.length === 1 ? "that row" : "those rows"} and import again.`;
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
  if (plan.mode === "replace") {
    const refusal = replaceRefusal(plan);
    if (refusal) throw new Error(refusal);
  }
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
