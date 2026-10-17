import { historyUnit } from "../../../cli/history-rows";
import { barsPerYearLabel } from "../../../market-data/bars-per-year";
import type { HeadlessBundleResult, HeadlessBundleSection, HeadlessPaneColumn, HeadlessPaneFreshness, HeadlessPaneRow } from "../../../types/headless";
import type { BacktestResult } from "./engine";
import { formatStat, SUMMARY_ROWS, type StatValue } from "./format";
import { continuationNote, type BacktestWindowOptions } from "./window";

/** A backtest of daily bars is not a feed; each run dates itself by the last session it tested. */
export const BACKTEST_FRESHNESS = {
  status: "not-a-feed", basis: "backtest on daily closes", observedKey: "date", oldest: null,
} as const satisfies HeadlessPaneFreshness;

/** Every report row of a backtest is of daily bars. */
const INTERVAL = "1d";

export interface BacktestReportInput {
  /** The symbol the run was asked for, as the report names it. */
  symbol: string;
  exchange?: string | null;
  rules: { entry: string; exit: string; label: string };
  costBps: number;
  window: BacktestWindowOptions;
  /** The currency the closes are quoted in, or their unit (`index points`); null when no source says. */
  unit: string | null;
  result: BacktestResult;
  /** The daily curve in place of the summary and trades. */
  equity?: boolean;
}

/** What the closes are in, as `history` names it: the quote's currency, a pair's counter currency, or index points. */
export function backtestPriceUnit(symbol: string, quote: { currency?: string; instrumentType?: string } | null | undefined): string | null {
  const unit = historyUnit(symbol, quote);
  return unit.currency ?? unit.unit;
}

const fixed = (digits: number) => (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "--";
/** Prices as the trades table drew them, with the digits a sub-unit price needs. */
const price = (value: unknown) => typeof value !== "number" || !Number.isFinite(value) ? "--"
  : Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(4);

/**
 * The daily curve: every session tested, the close in the listing's currency
 * (header unit from each row's `currency`), the position held over it, both
 * lines as the growth of 1 and the strategy's drawdown in percent. Exports
 * keep every digit; the text view rounds.
 */
const EQUITY_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date", literalHeader: true, shrink: false },
  { key: "close", header: "Close", literalHeader: true, align: "right", unitKey: "currency", format: price },
  { key: "position", header: "Position (1 long, 0 flat)", literalHeader: true, align: "right", format: (value) => String(value) },
  { key: "strategy", header: "Strategy (growth of 1)", literalHeader: true, align: "right", format: fixed(4) },
  { key: "benchmark", header: "Buy & hold (growth of 1)", literalHeader: true, align: "right", format: fixed(4) },
  { key: "drawdownPct", header: "Drawdown (%)", literalHeader: true, align: "right", format: fixed(2) },
];

function equitySection(result: BacktestResult, unit: string | null): HeadlessBundleSection {
  return {
    title: `Daily curve · ${result.start} to ${result.end}`,
    columns: EQUITY_COLUMNS,
    rows: result.equity.map((row): HeadlessPaneRow => ({ ...row, ...(unit ? { currency: unit } : {}) })),
    ...(unit ? { unit } : {}),
    interval: INTERVAL,
  };
}

/** A metric as the pane draws it; exports read the number back at full precision. */
const statCell = (value: unknown, row: HeadlessPaneRow) => formatStat(
  typeof value === "number" ? { value, kind: row.kind as StatValue["kind"] } : null,
);

function summarySections(input: BacktestReportInput): HeadlessBundleSection[] {
  const { result, unit } = input;
  const identity = { ...(unit ? { unit } : {}), interval: INTERVAL };
  return [
    {
      title: `${input.rules.label} · ${result.start} to ${result.end}`,
      columns: [
        { key: "metric", header: "Metric" },
        { key: "strategy", header: "Strategy", align: "right", format: statCell },
        { key: "benchmark", header: "Buy & hold", align: "right", format: statCell },
      ],
      rows: SUMMARY_ROWS.map((row) => {
        const strategy = row.strategy(result), benchmark = row.benchmark?.(result) ?? null;
        return { metric: row.label, strategy: strategy?.value ?? null, benchmark: benchmark?.value ?? null, kind: strategy?.kind ?? "ratio" };
      }),
      ...identity,
    },
    {
      title: "Trades",
      columns: [
        { key: "entryDate", header: "Entry" }, { key: "entryPrice", header: "Entry price", align: "right", format: fixed(2) },
        { key: "exitDate", header: "Exit" }, { key: "exitPrice", header: "Exit price", align: "right", format: fixed(2) },
        { key: "returnPct", header: "Return %", align: "right", format: fixed(2) }, { key: "sessions", header: "Sessions", align: "right" },
      ],
      rows: result.trades.map((trade) => ({
        entryDate: trade.entryDate, entryPrice: trade.entryPrice,
        exitDate: trade.open ? "open" : trade.exitDate, exitPrice: trade.exitPrice,
        returnPct: trade.returnPct, sessions: trade.sessions,
      })),
      ...identity,
    },
  ];
}

/**
 * A run as `fn BT` reports it and the pane exports it: the tables, every
 * left-out session as a warning, a futures continuation said in a note, and
 * the as-of the last session tested. Without an `end` the run follows the
 * newest session, so it is stale once the bars stop arriving; with one it is
 * dated by the day asked for and is never stale.
 */
export function backtestReport(input: BacktestReportInput): HeadlessBundleResult {
  const { result } = input;
  const continuation = continuationNote(input.symbol, input.exchange);
  const end = input.window.end?.trim() || null;
  return {
    complete: true,
    sections: input.equity ? [equitySection(result, input.unit)] : summarySections(input),
    ...(result.warnings.length ? { warnings: result.warnings } : {}),
    notes: [barsPerYearLabel(result.barsPerYear), ...(continuation ? [continuation] : [])],
    freshness: {
      asOf: result.end,
      ...(end ? {} : { cadence: "daily" as const, ...(input.exchange ? { cadenceExchange: input.exchange } : {}) }),
    },
    metadata: {
      symbol: input.symbol,
      rules: { ...input.rules, costBps: input.costBps },
      window: { end, includePartial: input.window.includePartial === true },
      unit: input.unit,
      annualization: result.barsPerYear,
      result,
    },
  };
}
