import type { ScreenDefinition, ScreenMetric, ScreenRow } from "../../../api-client/equity-screener";
import type { HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneRow } from "../../../types/headless";
import type { TickerFinancials } from "../../../types/financials";
import { isUsListingExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { errorMessage } from "../../../utils/errors";
import { formatNumber } from "../../../utils/format";
import { fetchScreen } from "../equity-screener/client";
import { refusedLock } from "../shared/cloud-denied";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { loadShortInterest } from "../short-interest/client";
import { buildShortWatchRow } from "../short-interest/watch-model";
import { analystTargetCurrency, formatAnalystPrice, recommendationTotal } from "./analyst-model";
import { peerDatesText } from "./relative-valuation-basis";

/** The columns `--columns` adds to RV's report, each read from the path its own function uses. */
export const EXTRA_COLUMN_IDS = ["shortInterest", "nextEarnings", "target", "grossMargin", "evEbitda"] as const;
export type ExtraColumnId = (typeof EXTRA_COLUMN_IDS)[number];

const COLUMN_ALIASES: Record<string, ExtraColumnId> = {
  shortinterest: "shortInterest", short: "shortInterest", si: "shortInterest", shortfloat: "shortInterest",
  nextearnings: "nextEarnings", earnings: "nextEarnings", earningsdate: "nextEarnings",
  target: "target", targets: "target", analysttarget: "target", analysts: "target", pricetarget: "target",
  grossmargin: "grossMargin", gross: "grossMargin", gm: "grossMargin",
  evebitda: "evEbitda", evtoebitda: "evEbitda",
};

/**
 * The report's own columns under the names a caller asks for them by. Asking for one adds nothing: `--columns trailingPE`
 * was refused as an unknown field, so the P/E the report already carries read as one RV could not give.
 */
const REPORT_COLUMN_NAMES = new Set([
  "symbol", "ticker", "price", "last", "changepercent", "chg", "change",
  "marketcap", "mktcap", "cap",
  "trailingpe", "pe", "peratio", "priceearnings", "pricetoearnings", "ttmpe",
  "forwardpe", "fwdpe",
  "evsales", "evs", "evtosales", "evrevenue", "evtorevenue",
  "fcfyield", "fcf", "freecashflowyield",
  "revenuegrowth", "quarterrevenueyoy", "revenueyoy", "growth",
  "operatingmargin", "opmargin", "ttmopmargin",
]);

const REPORT_COLUMNS_SENTENCE = "Last, Chg%, Mkt Cap, P/E, Fwd P/E, EV/S, FCF Yield, Quarter Revenue YoY and TTM Op Margin are always in the report";

/**
 * `--columns`: a comma list of the fields above (or their short names), in order, as the canonical names. A column the
 * report always has is accepted and adds nothing, so `--columns trailingPE` alone is the plain report.
 */
export function normalizeExtraColumns(value: string): string {
  const tokens = value.split(/[,\s]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error(`--columns needs one or more of: ${EXTRA_COLUMN_IDS.join(", ")}.`);
  const ids = tokens.flatMap((token) => {
    const name = token.toLowerCase().replace(/[^a-z]/g, "");
    const id = COLUMN_ALIASES[name];
    if (id) return [id];
    if (REPORT_COLUMN_NAMES.has(name)) return [];
    throw new Error(`Unknown --columns field "${token}". Use any of: ${EXTRA_COLUMN_IDS.join(", ")}. ${REPORT_COLUMNS_SENTENCE}.`);
  });
  return [...new Set(ids)].join(",");
}

export function parseExtraColumns(value: unknown): ExtraColumnId[] {
  return typeof value === "string" && value ? value.split(",").filter((id): id is ExtraColumnId => (EXTRA_COLUMN_IDS as readonly string[]).includes(id)) : [];
}

const percent = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}%` : "-");
const text = (value: unknown) => (typeof value === "string" && value ? value : "-");

/** Each added column, then (exports only) the source and as-of of its cells. */
interface ColumnSpec {
  columns: HeadlessPaneColumn[];
  sourceKey: string;
  asOfKey: string;
  label: string;
  /**
   * What the column's figures are as of, for the report's footer, from the
   * dates of its cells (`fiscal year to 2025-12-31`). A column dated only by
   * when it was read (targets, the earnings calendar) has none.
   */
  basis?: (dates: string) => string;
}

const COLUMN_SPECS: Record<ExtraColumnId, ColumnSpec> = {
  shortInterest: {
    label: "Short % Float",
    columns: [{ key: "shortInterestPercentFloat", header: "Short % Float", align: "right", format: percent }],
    sourceKey: "shortInterestSource",
    asOfKey: "shortInterestAsOf",
    basis: (dates) => `settlement ${dates}`,
  },
  nextEarnings: {
    label: "Next Earnings",
    columns: [{
      key: "nextEarningsDate", header: "Next Earnings", format: text, shrink: false,
      // The text table says when in the day and whether the date is confirmed; exports keep them as columns.
      textFormat: (value, row) => (typeof value === "string" && value
        ? [value, row.nextEarningsTiming, row.nextEarningsStatus === "estimated" ? "est" : null].filter(Boolean).join(" ") : "-"),
    }, { key: "nextEarningsTiming", header: "Next Earnings Timing", format: text }, { key: "nextEarningsStatus", header: "Next Earnings Status", format: text }],
    sourceKey: "nextEarningsSource",
    asOfKey: "nextEarningsAsOf",
  },
  target: {
    label: "Avg Target",
    columns: [
      { key: "targetMean", header: "Avg Target", align: "right", unitKey: "targetCurrency", unitColumn: true,
        format: (value, row) => (typeof value === "number" ? formatAnalystPrice(value, typeof row.targetCurrency === "string" ? row.targetCurrency : undefined) : "-") },
      { key: "analystCount", header: "Analysts", align: "right", format: (value) => (typeof value === "number" ? String(value) : "-") },
    ],
    sourceKey: "targetSource",
    asOfKey: "targetAsOf",
  },
  grossMargin: {
    label: "Gross Margin",
    columns: [{ key: "grossMarginPercent", header: "Gross Margin", align: "right", format: percent }],
    sourceKey: "grossMarginSource",
    asOfKey: "grossMarginAsOf",
    // The screener stores the fiscal year's margin (its FY GROSS MGN%), dated by the year's end.
    basis: (dates) => `fiscal year to ${dates}`,
  },
  evEbitda: {
    label: "EV/EBITDA",
    columns: [{ key: "evEbitda", header: "EV/EBITDA", align: "right", format: (value) => (typeof value === "number" ? formatNumber(value, 1) : "-") }],
    sourceKey: "evEbitdaSource",
    asOfKey: "evEbitdaAsOf",
    basis: (dates) => `statements to ${dates}`,
  },
};

/** The timing and status columns of Next Earnings stay out of the text table, which folds them into the date. */
const EXPORT_ONLY_KEYS = new Set(["nextEarningsTiming", "nextEarningsStatus"]);

/** The columns the added fields print as: `text` for the terminal table, `export` with each cell's source and as-of. */
export function extraColumns(ids: readonly ExtraColumnId[]): { text: HeadlessPaneColumn[]; export: HeadlessPaneColumn[] } {
  const specs = ids.map((id) => COLUMN_SPECS[id]);
  return {
    text: specs.flatMap((spec) => spec.columns.filter((column) => !EXPORT_ONLY_KEYS.has(column.key))),
    export: specs.flatMap((spec) => [
      ...spec.columns,
      { key: spec.sourceKey, header: `${spec.label} source`, format: text },
      { key: spec.asOfKey, header: `${spec.label} as of`, format: text, shrink: false },
    ]),
  };
}

/**
 * The footer's word on each added column dated by its figures: `Gross Margin:
 * fiscal year to 2025-12-31`, beside the TTM columns' `fundamentals through`.
 */
export function extraColumnsBasis(ids: readonly ExtraColumnId[], rows: readonly HeadlessPaneRow[]): string[] {
  return ids.flatMap((id) => {
    const spec = COLUMN_SPECS[id];
    const valueKey = spec.columns[0]!.key;
    const dates = spec.basis && peerDatesText(rows.filter((row) => row[valueKey] != null)
      .map((row) => ({ symbol: String(row.symbol), date: typeof row[spec.asOfKey] === "string" ? row[spec.asOfKey] as string : null })));
    return dates ? [`${spec.label}: ${spec.basis!(dates)}`] : [];
  });
}

/** Whether a symbol is a US listing, which FINRA short interest, the earnings calendar and the screener cover. */
function usListing(symbol: string): string | null {
  const { symbol: bare, exchange } = parsePublicTickerKey(symbol);
  return !exchange || isUsListingExchange(exchange) ? bare.toUpperCase() : null;
}

/** A failed read of one column, as the report says it: a Pro or sign-in wall in the words its lock note uses, else why. */
function failureMessage(label: string, error: unknown, symbol?: string): string {
  const refused = refusedLock(error);
  if (refused?.gate === "pro") return `${label} requires Gloom Pro.`;
  if (refused) return `${label} needs a free Gloom sign-in.`;
  return `${symbol ? `${symbol}: ` : ""}${label} unavailable: ${errorMessage(error)}`;
}

interface ExtraColumnsResult {
  /** The added fields of each symbol's row, keyed by the symbol as given. */
  fields: Map<string, HeadlessPaneRow>;
  errors: string[];
  notes: string[];
}

const SHORT_INTEREST_SOURCES: Record<string, string> = { finra: "FINRA", gloom: "Gloom Cloud" };

/** Percent of float at the latest settlement, as `SIW` computes it, dated by that settlement. */
async function loadShortInterestFields(symbols: readonly string[], financials: ReadonlyMap<string, TickerFinancials | null>, ctx: HeadlessPaneContext, out: ExtraColumnsResult) {
  const label = COLUMN_SPECS.shortInterest.label;
  await Promise.all(symbols.map(async (symbol) => {
    const bare = usListing(symbol);
    if (!bare) return;
    try {
      const result = await loadShortInterest(bare, ctx.apiClient);
      const row = buildShortWatchRow({ symbol, records: result.records, floatShares: financials.get(symbol)?.fundamentals?.floatShares ?? null, history: null });
      if (!row.settlementDate) return;
      Object.assign(out.fields.get(symbol)!, {
        shortInterestPercentFloat: row.percentFloat,
        shortInterestSource: SHORT_INTEREST_SOURCES[result.source] ?? "FINRA",
        shortInterestAsOf: row.settlementDate,
      });
    } catch (error) {
      out.errors.push(failureMessage(label, error, symbol));
    }
  }));
}

/** The next report date on the earnings calendar `earnings` reads, dated by when the calendar was read. */
async function loadNextEarningsFields(symbols: readonly string[], ctx: HeadlessPaneContext, out: ExtraColumnsResult) {
  const label = COLUMN_SPECS.nextEarnings.label;
  const listed = symbols.flatMap((symbol) => {
    const bare = usListing(symbol);
    return bare ? [{ symbol, bare }] : [];
  });
  if (listed.length === 0) return;
  if (!ctx.marketData.getEarningsCalendar) {
    out.errors.push(`${label} unavailable: the market data source has no earnings calendar.`);
    return;
  }
  try {
    const events = await ctx.marketData.getEarningsCalendar(listed.map(({ bare }) => bare));
    const readAt = new Date().toISOString();
    const today = readAt.slice(0, 10);
    for (const { symbol, bare } of listed) {
      const next = events
        .filter((event) => event.symbol.toUpperCase() === bare && event.epsActual == null && event.earningsDate.toISOString().slice(0, 10) >= today)
        .sort((left, right) => left.earningsDate.getTime() - right.earningsDate.getTime())[0];
      if (!next) continue;
      Object.assign(out.fields.get(symbol)!, {
        nextEarningsDate: next.earningsDate.toISOString().slice(0, 10),
        nextEarningsTiming: next.timing || null,
        nextEarningsStatus: next.isDateEstimate === true ? "estimated" : next.isDateEstimate === false ? "confirmed" : null,
        nextEarningsSource: "Gloom Cloud earnings calendar",
        nextEarningsAsOf: readAt,
      });
    }
  } catch (error) {
    out.errors.push(failureMessage(label, error));
  }
}

/** The mean analyst target and the analysts behind the latest recommendation mix, as `analyst` reads them. */
async function loadTargetFields(symbols: readonly string[], ctx: HeadlessPaneContext, out: ExtraColumnsResult) {
  const label = COLUMN_SPECS.target.label;
  const read = ctx.marketData.getAnalystResearch?.bind(ctx.marketData);
  if (!read) {
    out.errors.push(`${label} unavailable: the market data source has no analyst research.`);
    return;
  }
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const { symbol: ticker, exchange } = await resolveHeadlessInstrument(ctx, symbol);
      const data = await read(ticker, exchange ?? "");
      const average = data.priceTarget?.average;
      const count = recommendationTotal(data);
      if (average == null && count == null) return;
      Object.assign(out.fields.get(symbol)!, {
        targetMean: average != null && Number.isFinite(average) ? average : null,
        targetCurrency: analystTargetCurrency(data) ?? null,
        analystCount: count,
        targetSource: "Gloom Cloud analyst research",
        targetAsOf: data.fetchedAt ?? new Date().toISOString(),
      });
    } catch (error) {
      out.errors.push(failureMessage(label, error, symbol));
    }
  }));
}

function metricFields(metric: ScreenMetric | undefined): { value: number | null; source: string | null; asOf: string | null } | null {
  if (!metric || metric.value == null || !Number.isFinite(metric.value) || metric.state === "unavailable") return null;
  return { value: metric.value, source: metric.source || null, asOf: metric.asOf ?? metric.observedAt ?? null };
}

/** Gross margin and EV/EBITDA as the screener stores them, each with its own source and statement date. */
async function loadScreenerFields(ids: readonly ExtraColumnId[], symbols: readonly string[], ctx: HeadlessPaneContext, out: ExtraColumnsResult) {
  const wanted = ids.filter((id) => id === "grossMargin" || id === "evEbitda");
  const listed = symbols.flatMap((symbol) => {
    const bare = usListing(symbol);
    return bare ? [{ symbol, bare }] : [];
  });
  if (wanted.length === 0 || listed.length === 0) return;
  const definition: ScreenDefinition = {
    version: 1,
    criteria: [{ field: "symbol", op: "in", value: [...new Set(listed.map(({ bare }) => bare))] }],
    sort: { field: "symbol", direction: "asc" },
    currency: null,
  };
  let rows: ScreenRow[];
  try {
    rows = (await fetchScreen(definition, null, ctx.signal, ctx.apiClient)).rows;
  } catch (error) {
    out.errors.push(failureMessage(wanted.map((id) => COLUMN_SPECS[id].label).join(" and "), error));
    return;
  }
  for (const { symbol, bare } of listed) {
    const row = rows.find((candidate) => candidate.symbol.toUpperCase() === bare && isUsListingExchange(candidate.exchange));
    if (!row) continue;
    const fields = out.fields.get(symbol)!;
    if (wanted.includes("grossMargin")) {
      const gross = metricFields(row.metrics.grossMarginPercent);
      if (gross) Object.assign(fields, { grossMarginPercent: gross.value, grossMarginSource: gross.source, grossMarginAsOf: gross.asOf });
    }
    if (wanted.includes("evEbitda")) {
      const multiple = metricFields(row.metrics.evToEbitda);
      if (multiple) Object.assign(fields, { evEbitda: multiple.value, evEbitdaSource: multiple.source, evEbitdaAsOf: multiple.asOf });
    }
  }
}

/** The US-only columns among `ids`, which a listing abroad leaves blank. */
const US_ONLY: ReadonlySet<ExtraColumnId> = new Set(["shortInterest", "nextEarnings", "grossMargin", "evEbitda"]);

/**
 * The added fields for every symbol, each column read apart so one that
 * fails (or is locked) leaves the others: short interest from FINRA's
 * settlements, the next report date from the earnings calendar, the mean
 * target and analyst count from analyst research, gross margin and EV/EBITDA
 * from the screener's stored figures.
 */
export async function loadExtraColumns(
  ids: readonly ExtraColumnId[],
  symbols: readonly string[],
  financials: ReadonlyMap<string, TickerFinancials | null>,
  ctx: HeadlessPaneContext,
): Promise<ExtraColumnsResult> {
  const out: ExtraColumnsResult = { fields: new Map(symbols.map((symbol) => [symbol, {}])), errors: [], notes: [] };
  if (ids.length === 0) return out;
  await Promise.all([
    ids.includes("shortInterest") ? loadShortInterestFields(symbols, financials, ctx, out) : null,
    ids.includes("nextEarnings") ? loadNextEarningsFields(symbols, ctx, out) : null,
    ids.includes("target") ? loadTargetFields(symbols, ctx, out) : null,
    loadScreenerFields(ids, symbols, ctx, out),
  ]);
  ctx.signal.throwIfAborted();
  const abroad = symbols.filter((symbol) => !usListing(symbol));
  const usOnly = ids.filter((id) => US_ONLY.has(id)).map((id) => COLUMN_SPECS[id].label);
  if (abroad.length > 0 && usOnly.length > 0) {
    out.notes.push(`${usOnly.join(", ")} cover US listings; ${abroad.join(", ")} ${abroad.length === 1 ? "is" : "are"} left blank.`);
  }
  return out;
}
