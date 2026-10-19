import { cleanFloat32Price, historyUnit } from "../../../cli/history-rows";
import { barsPerYearLabel } from "../../../market-data/bars-per-year";
import type { HeadlessBundleResult, HeadlessBundleSection, HeadlessPaneColumn, HeadlessPaneFreshness, HeadlessPaneRow } from "../../../types/headless";
import { formatStat, PRICE_RETURN_LABEL, PRICE_RETURN_NOTE, SUMMARY_ROWS, type StatValue } from "./format";
import { continuationNote, type BacktestWindowOptions, type HistoryBacktestResult } from "./window";

/**
 * A backtest of daily bars is not a feed; each run dates itself by the last
 * session it tested. Its source line says what its returns are, which is where
 * a capture of the pane says it.
 */
export const BACKTEST_FRESHNESS = {
  status: "not-a-feed", basis: `backtest on daily closes, ${PRICE_RETURN_NOTE}`, observedKey: "date", oldest: null,
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
  result: HistoryBacktestResult;
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
 * lines as the growth of 1 on the price alone and the strategy's drawdown in percent. Exports
 * keep every digit; the text view rounds. The close is the price as `history`
 * exports it, without a float32 feed's noise (671.29999 is 671.3); the run
 * itself used the price as served.
 */
const EQUITY_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date", literalHeader: true, shrink: false },
  { key: "close", header: "Close", literalHeader: true, align: "right", unitKey: "currency", format: price },
  { key: "position", header: "Position (1 long, 0 flat)", literalHeader: true, align: "right", format: (value) => String(value) },
  { key: "strategy", header: "Strategy (growth of 1)", literalHeader: true, align: "right", format: fixed(4) },
  { key: "benchmark", header: "Buy & hold (growth of 1)", literalHeader: true, align: "right", format: fixed(4) },
  { key: "drawdownPct", header: "Drawdown (%)", literalHeader: true, align: "right", format: fixed(2) },
];

/**
 * Both lines grow by the price alone, so a saved curve's headers say so; the
 * text table, which a terminal must fit, says it once in its title instead.
 */
const EXPORTED_EQUITY_COLUMNS: HeadlessPaneColumn[] = EQUITY_COLUMNS.map((column) => column.key === "strategy" || column.key === "benchmark"
  ? { ...column, header: column.header.replace(")", ", price return, distributions not included)") }
  : column);

function equitySection(result: HistoryBacktestResult, unit: string | null): HeadlessBundleSection {
  return {
    title: `Daily curve, ${PRICE_RETURN_LABEL.toLowerCase()} · ${result.start} to ${result.end}`,
    columns: EXPORTED_EQUITY_COLUMNS,
    textColumns: EQUITY_COLUMNS,
    rows: result.equity.map((row): HeadlessPaneRow => ({ ...row, close: cleanFloat32Price(row.close), ...(unit ? { currency: unit } : {}) })),
    ...(unit ? { unit } : {}),
    interval: INTERVAL,
  };
}

/** A metric as the pane draws it; exports read the number back at full precision. */
const statCell = (value: unknown, row: HeadlessPaneRow) => formatStat(
  typeof value === "number" ? { value, kind: row.kind as StatValue["kind"] } : null,
);

/** What a summary row is in: percent, a ratio, or what its count counts. Never a currency: no metric is money. */
function summaryUnit(kind: StatValue["kind"], countUnit: string | undefined): string {
  return kind === "count" ? countUnit ?? "" : kind === "ratio" ? "ratio" : "%";
}

function summarySections(input: BacktestReportInput): HeadlessBundleSection[] {
  const { result, unit } = input;
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
        const kind = strategy?.kind ?? "ratio";
        return {
          metric: row.label, strategy: strategy?.value ?? null, benchmark: benchmark?.value ?? null, kind, unit: summaryUnit(kind, row.countUnit),
        };
      }),
      rowUnitKey: "unit",
      interval: INTERVAL,
    },
    {
      // Prices are in the listing's currency, which the row names; the return and the hold say their own units.
      title: "Trades",
      columns: [
        { key: "entryDate", header: "Entry" },
        { key: "entryPrice", header: "Entry price", align: "right", unitKey: "currency", format: fixed(2) },
        { key: "exitDate", header: "Exit" },
        { key: "exitPrice", header: "Exit price", align: "right", unitKey: "currency", format: fixed(2) },
        { key: "returnPct", header: "Return %", align: "right", format: fixed(2) }, { key: "sessions", header: "Sessions", align: "right" },
      ],
      rows: result.trades.map((trade) => ({
        entryDate: trade.entryDate, entryPrice: trade.entryPrice,
        exitDate: trade.open ? "open" : trade.exitDate, exitPrice: trade.exitPrice,
        returnPct: trade.returnPct, sessions: trade.sessions, ...(unit ? { currency: unit } : {}),
      })),
      ...(unit ? { unit } : {}),
      interval: INTERVAL,
    },
  ];
}

/**
 * A run as `fn BT` reports it and the pane exports it: the tables, every
 * left-out session as a warning, the annualisation and a futures
 * continuation said in notes, and the as-of the last session tested. A run
 * that follows the newest session is stale once the bars stop arriving; one
 * with an end already served is dated by it and is never stale.
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
      ...(result.repeatable ? {} : { cadence: "daily" as const, ...(input.exchange ? { cadenceExchange: input.exchange } : {}) }),
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
