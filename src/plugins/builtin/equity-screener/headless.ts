import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { isProLock } from "../../../cli/pane-functions/access-gate";
import type { HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneEntry } from "../../../types/headless";
import {
  KPI_FIELDS,
  NUMERIC_FIELDS,
  type NumericField,
  type ScreenMetric,
  type ScreenPayload,
  type ScreenRow,
} from "../../../api-client/equity-screener";
import { KPI_COVERAGE_NOTE } from "../company-kpis/model";
import { EXTENDED_SESSION_LABELS, type ExtendedSession } from "../../../market-data/market/status";
import { buildQuoteKey } from "../../../market-data/selectors";
import type { Quote } from "../../../types/financials";
import { MISSING_VALUE, formatCurrency, formatPercentRaw } from "../../../utils/format";
import { currencyPriceMinDigits, formatMarketPriceWithCurrency } from "../../../market-data/market/format";
import { fetchSavedScreens, fetchScreen, fetchScreenCheck } from "./client";
import { ideaMetricSetting, SCREEN_IDEAS, screenIdea, type ScreenIdea } from "./ideas";
import { checkRows, screenCheckSummary, screenCheckTicker } from "./screen-check";
import { overlayScreenQuotes, screenExtendedSessions, sortLiveScreenRows } from "./live";
import {
  CATEGORY_NAMES_POINTER,
  SCREEN_INDUSTRIES,
  SCREEN_SECTORS,
  unmatchedCategoryText,
  unmatchedCategoryValues,
} from "./categories";
import { REPORT_ROWS } from "../shared/headless-options";
import { shellWord } from "../../../utils/shell-word";
import { findNamedCollection, readWatchlistArgument } from "../../../portfolio/collection-name";
import {
  appendScreenPage,
  criterionText,
  DEFAULT_SCREEN,
  EXAMPLE_SCREEN_DEFINITION,
  formatScreenMetric,
  WATCHLIST_SCREEN_DEFINITION,
  MAX_SYMBOL_VALUES,
  metricDate,
  parseScreenDefinition,
  screenColumnLabel,
  screenDefinitionSyntax,
  screenCurrencyEmpty,
  screenLabel,
  screenListings,
  listingReadNotes,
  screenYtdBase,
  withheldMetricNote,
} from "./model";
import type { ScreenDefinition } from "../../../api-client/equity-screener";

/** JSON with a space after each comma and colon, so a wrapped command line breaks between tokens and still pastes. */
const spacedJson = (definition: ScreenDefinition) =>
  JSON.stringify(definition).replace(/([,:])(?=["{[\d-])/g, "$1 ");

/**
 * A symbol criterion whose one value names a watchlist (`"value": ["HY3"]`)
 * reads as the watchlist's listings with their venues, at most a screen's
 * 500, with the note that says so; any other criterion is left as it is. The
 * screener matches each by company (BN:TSX is Brookfield, never Danone's BN
 * in Paris).
 */
async function withWatchlistSymbols(
  definition: ScreenDefinition,
  ctx: Pick<HeadlessPaneContext, "config" | "resolveWatchlist">,
): Promise<{ definition: ScreenDefinition; notes: string[] }> {
  const notes: string[] = [];
  const criteria = await Promise.all(definition.criteria.map(async (criterion) => {
    if (criterion.field !== "symbol" || criterion.op !== "in" || criterion.value.length !== 1) return criterion;
    const typed = criterion.value[0]!;
    const watchlist = findNamedCollection(ctx.config.watchlists, typed);
    if (!watchlist || !ctx.resolveWatchlist) return criterion;
    const members = screenListings(((await ctx.resolveWatchlist(typed)) ?? []).map((ticker) => ticker.metadata));
    if (members.length === 0) return criterion;
    const read = readWatchlistArgument(typed, watchlist, members, MAX_SYMBOL_VALUES);
    notes.push(read.note);
    return { ...criterion, value: read.symbols };
  }));
  return notes.length ? { definition: { ...definition, criteria }, notes } : { definition, notes };
}

/** The `--definition` value of the catalog's worked example, quoted for a shell. */
const EXAMPLE_DEFINITION_OPTION = `--definition '${spacedJson(EXAMPLE_SCREEN_DEFINITION)}'`;

/**
 * Each row's quote through the standard quote path, keyed as the overlay
 * reads it. A row without one, or every row when the batch fails, keeps the
 * snapshot's figures.
 */
async function loadRowQuotes(rows: readonly ScreenRow[], ctx: HeadlessPaneContext): Promise<Map<string, Quote>> {
  const provider = ctx.marketData;
  if (!provider?.getQuotesBatch || rows.length === 0) return new Map();
  try {
    const results = await provider.getQuotesBatch(
      rows.map((row) => ({ symbol: row.symbol, exchange: row.exchange })),
      { forceRefresh: ctx.refresh, signal: ctx.signal },
    );
    return new Map(results.flatMap((result) => result.quote ? [[buildQuoteKey(result.target), result.quote] as const] : []));
  } catch {
    return new Map();
  }
}

// A line quoted in pence keeps the decimals it trades in (GCP's £0.828), as `quote` prints it.
const price = (value: unknown, row: Record<string, unknown>) =>
  typeof value !== "number" || typeof row.currency !== "string" || !row.currency ? MISSING_VALUE
    : typeof row.quotedUnitDivisor === "number" && row.quotedUnitDivisor > 1
      ? formatMarketPriceWithCurrency(value, row.currency, { minimumFractionDigits: currencyPriceMinDigits(row.currency), quotedUnitDivisor: row.quotedUnitDivisor })
      : formatCurrency(value, row.currency);
const percent = (value: unknown) => typeof value === "number" ? formatPercentRaw(value) : MISSING_VALUE;

/** The pre-market, after-hours or overnight print and its move from the close in Last, for the rows that have one. */
function extendedColumn(session: ExtendedSession): HeadlessPaneColumn {
  return {
    key: "extendedPrice",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right",
    format: (value, row) => row.extendedSession === session && typeof value === "number"
      ? `${price(value, row)}${row.extendedMark ? " mid" : ""} ${percent(row.extendedChangePercent)}`
      : MISSING_VALUE,
  };
}

/** Rows a report lists without `--limit`: one page, as the pane loads before it pages. */
const SCREEN_PAGE_ROWS = 100;
/** The most rows `--limit` lists, read a page at a time. */
const SCREEN_ROW_LIMIT = 500;
/** The most rows the server returns in one page. */
const SCREEN_MAX_PAGE = 200;

/** The rows a report lists: pages of the screen, in its order, until `limit` rows or the last match. */
async function fetchScreenRows(definition: ScreenDefinition, limit: number, ctx: HeadlessPaneContext): Promise<ScreenPayload> {
  let data = await fetchScreen(definition, null, ctx.signal, ctx.apiClient, Math.min(limit, SCREEN_MAX_PAGE));
  while (data.rows.length < limit && data.nextCursor) {
    const page = await fetchScreen(definition, data.nextCursor, ctx.signal, ctx.apiClient, Math.min(limit - data.rows.length, SCREEN_MAX_PAGE));
    data = { ...appendScreenPage(data, page), warnings: [...new Set([...data.warnings, ...page.warnings])] };
  }
  return data;
}

/** What a report of the first rows says of the rest. */
function moreMatchesNotice(shown: number, matched: number): string {
  return matched <= SCREEN_ROW_LIMIT
    ? `Top ${shown} of ${matched} matches; --limit ${matched} lists them all.`
    : `Top ${shown} of ${matched} matches; --limit lists up to ${SCREEN_ROW_LIMIT}, or narrow the criteria to see the rest.`;
}

const isNumericField = (field: string): field is NumericField => (NUMERIC_FIELDS as readonly string[]).includes(field);
const metricToken = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, "");

/** `--metric trailingPE,dividendYieldPercent` as the fields it names, each once, in order; an unknown one fails. */
function readMetrics(value: string): NumericField[] {
  const fields = value.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const field = NUMERIC_FIELDS.find((candidate) => metricToken(candidate) === metricToken(part));
    if (!field) throw new Error(`Invalid --metric value "${part}". Use one of: ${NUMERIC_FIELDS.join(", ")}.`);
    return field;
  });
  if (fields.length === 0) throw new Error("--metric requires a value, such as --metric trailingPE.");
  return [...new Set(fields)];
}

type ShownCategory = "sector" | "industry" | "currency";
const CATEGORY_HEADERS: Record<ShownCategory, string> = { sector: "Sector", industry: "Industry", currency: "Currency" };
/** Columns every report prints, so neither another metric nor the sort field adds them again. */
const ALWAYS_SHOWN = new Set(["symbol", "exchange", "name", "price", "changePercent"]);

/**
 * The columns a report adds after the first metric's: the other metrics
 * asked for, then the field the screen is sorted by, so the order of the
 * rows is explained by a column (P/E focus, sorted by dividend yield). A
 * column every report prints (Last, Chg%) is not added twice, and its raw
 * number stays in the row.
 */
function extraScreenColumns(metrics: readonly NumericField[], sortField: string): Array<NumericField | ShownCategory> {
  return [...new Set([...metrics.slice(1), sortField as NumericField | ShownCategory])]
    .filter((field) => field !== metrics[0] && !ALWAYS_SHOWN.has(field));
}

/** Another metric's cell: its value as the focus column prints it, with the currency of a money value. */
function extraMetricCell(field: NumericField, metric: ScreenMetric | undefined): string {
  if (!metric) return MISSING_VALUE;
  if (metric.access === "pro") return "locked";
  const value = formatScreenMetric(field, metric);
  return metric.value != null && /^[A-Z]{3}$/.test(metric.unit) ? `${value} ${metric.unit}` : value;
}

/** What the State columns' words mean, said once under a report where a shown metric has them. */
const STATE_LEGEND: ReadonlyArray<{ state: ScreenMetric["state"]; text: string }> = [
  { state: "partial", text: "A partial State means the source gives no date for the figure, so As of is when it was collected, or that it covers part of what it measures." },
  { state: "stale", text: "A stale State means the figure is older than its field allows, such as a price from before its exchange's latest session, a quote over 4 days old or fundamentals collected over 7 days ago." },
];

/** A date as a report cell prints it: a day as it is, an instant to the minute in UTC. */
function stampText(stamp: unknown): string {
  if (typeof stamp !== "string" || !stamp) return MISSING_VALUE;
  if (/^\d{4}-\d{2}-\d{2}$/.test(stamp)) return stamp;
  const time = Date.parse(stamp);
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC` : stamp;
}

/**
 * A metric's own As of and State, as the first metric's columns print them.
 * A forecast is dated by when it was given, and names the period it is for
 * apart, so a forward date never reads as when the figure was observed.
 */
function metricStamp(metric: ScreenMetric | undefined): { asOf: string; state: string } {
  if (!metric) return { asOf: MISSING_VALUE, state: MISSING_VALUE };
  const stamp = metricDate(metric);
  const date = stamp.collected ? `${stamp.text} (collected)` : stamp.text;
  return {
    asOf: metric.periodEnd ? `${date} (for the period ending ${metric.periodEnd})` : date,
    state: metric.access === "pro" ? "locked" : metric.state,
  };
}

/**
 * When the row's Last is from (the session it closed, the time it traded, or
 * when a last price on record was printed), its state, and, when it is not a
 * current price, why.
 */
function lastStamp(metric: ScreenMetric): { at: string | null; state: string; note: string | null } {
  const at = metric.printedAt ?? metric.asOf ?? (metric.value != null ? metric.observedAt : null);
  const note = metric.value == null || metric.state === "available" ? null
    : metric.reason ?? (metric.state === "stale" ? "The last price on record: older than a current price allows" : null);
  return { at, state: metric.state, note };
}

/** The column the rows are ordered by: the first metric's, one every report prints, or the one `extraScreenColumns` adds for the sort. */
function sortedColumnKey(sortField: string, metric: NumericField): string {
  return sortField === metric ? "value" : sortField;
}

/**
 * What the rows are: the screen as it ran, how they are ordered, and the
 * snapshot they come from, so a saved report says how to get them again. The
 * command is the definition exactly, as text an export keeps whole (a JSON
 * cell would be flattened into words).
 */
function screenEntries(
  data: ScreenPayload,
  sortedBy: string,
  source: { preset?: ScreenIdea; savedName?: string; metrics: readonly NumericField[] },
): HeadlessPaneEntry[] {
  const { definition, snapshot, universe } = data;
  const direction = definition.sort.direction === "desc" ? "descending" : "ascending";
  return [
    ...(source.preset ? [{ key: "preset", label: "Preset", value: `${source.preset.name} (--preset ${source.preset.id})` }] : []),
    ...(source.savedName ? [{ key: "savedScreen", label: "Saved screen", value: source.savedName }] : []),
    { key: "criteria", label: "Criteria", value: definition.criteria.length ? definition.criteria.map(criterionText).join("; ") : "None" },
    { key: "currency", label: "Currency", value: definition.currency ?? "None: no criterion compares money" },
    { key: "sort", label: "Sorted by", value: `${sortedBy} (${definition.sort.field}), ${direction}` },
    { key: "command", label: "Command", value: `gloom fn EQS --definition ${shellWord(spacedJson(definition))} --metric ${source.metrics.join(",")}` },
    { key: "snapshot", label: "Snapshot", value: snapshot?.id ?? MISSING_VALUE },
    { key: "assembledAt", label: "Assembled", value: snapshot?.assembledAt ?? MISSING_VALUE },
    { key: "matched", label: "Matches", value: `${universe.matched.toLocaleString("en-US")} of ${universe.covered.toLocaleString("en-US")} covered listings` },
  ];
}

/** The newest input the snapshot observed, as of its assembly or before; a later date is no observation. */
function newestInput(snapshot: ScreenPayload["snapshot"]): string | null {
  const newest = snapshot?.sourceNewestAt;
  if (!newest || !snapshot) return null;
  const at = Date.parse(newest), assembled = Date.parse(snapshot.assembledAt);
  return Number.isFinite(at) && Number.isFinite(assembled) && at <= assembled ? newest : null;
}

/** A typed `--definition`, checked; every error points at the worked example. */
function readDefinition(text: string): ScreenDefinition {
  const pointer = "The example in gloom catalog EQS is a valid definition to start from.";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`--definition is not valid JSON (${error instanceof Error ? error.message : String(error)}). ${pointer}`);
  }
  try {
    return parseScreenDefinition(value);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${pointer}`);
  }
}

/**
 * What the screen an empty currency falls back to is in: the base currency
 * set, when the screener runs in it (`In USD, your base currency`), else the
 * screener's own and why (`In USD: the screener converts no figure into CAD,
 * your base currency, …`).
 */
function currencyFallbackLead(screenCurrency: string, baseCurrency: string | undefined): string {
  const base = baseCurrency?.trim().toUpperCase() || screenCurrency;
  return base === screenCurrency
    ? `In ${screenCurrency}, your base currency`
    : `In ${screenCurrency}: the screener converts no figure into ${base}, your base currency, so a screen in ${base} reads only the listings quoted in it`;
}

export const equityScreenerHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: { status: "not-a-feed", basis: "screener snapshot" },
  argument: { kind: "none" },
  options: [
    {
      key: "check",
      type: "string",
      placeholder: "ticker",
      description: "Check one ticker against every criterion, including the screen's currency filter.",
      example: "--check NVDA",
      shot: { reportOnly: "checks a ticker against the screen; use Check ticker in the EQS pane" },
      normalize: (value) => {
        screenCheckTicker(value);
        return value.trim();
      },
    },
    {
      key: "saved",
      type: "string",
      placeholder: "id-or-name",
      description: "Use a saved screen by ID or exact name. Cannot be combined with --definition.",
      shot: { reportOnly: "opens a saved screen for the report; open it from Saved in the EQS pane" },
      replaces: ["definition"],
    },
    {
      key: "preset",
      type: "enum",
      description: `A ready screen from Ideas, ranked by its own metric unless --metric says otherwise: ${SCREEN_IDEAS.map((entry) => `${entry.id} (${entry.name})`).join(", ")}. Cannot be combined with --saved or --definition.`,
      values: SCREEN_IDEAS.map((entry) => ({ value: entry.id })),
      example: "--preset golden-cross",
      replaces: ["definition", "saved"],
    },
    {
      key: "definition",
      type: "string",
      placeholder: "json",
      description: screenDefinitionSyntax(),
      example: EXAMPLE_DEFINITION_OPTION,
      examples: [`--definition '${spacedJson(WATCHLIST_SCREEN_DEFINITION)}'`],
      normalize: (value) => {
        readDefinition(value);
        return value;
      },
    },
    {
      key: "metric",
      type: "enum",
      list: true,
      // No default: a preset leads with its own metric, anything else with marketCap.
      description:
        "Metric to display with its source date and covered-universe rank: marketCap, or the preset's own metric. Several, as a comma list or the flag again, add a column each after the first.",
      example: "--metric trailingPE --metric dividendYieldPercent",
      values: NUMERIC_FIELDS.map((value) => ({ value })),
      normalize: (value) => readMetrics(value).join(","),
    },
    {
      key: "limit",
      type: "integer",
      shot: REPORT_ROWS,
      minimum: 1,
      maximum: SCREEN_ROW_LIMIT,
      defaultValue: SCREEN_PAGE_ROWS,
      description: `Matching rows to list, in the screen's order, up to ${SCREEN_ROW_LIMIT}.`,
      example: "--limit 40",
    },
  ],
  describe: "Equity screener",
  discovery: {
    aliases: ["EQS"],
    reference: [
      { title: "Sectors", items: [...SCREEN_SECTORS] },
      { title: "Industries", items: [...SCREEN_INDUSTRIES] },
    ],
    dataRequirements: ["Gloom Cloud stored screener snapshot"],
    limitations: [
      "Covered stored universe, not every listed equity.",
      "Ranks are cross-sectional and dates differ by field.",
      "Observed-subset insider activity cannot establish an absence.",
      "ATR% is the 14-session average true range as a percent of the last close, for US listings with at least 15 completed daily sessions.",
      "IV rank is a rank, not an IV percentile: 0 is the lowest 30-day implied volatility of the past 52 weeks and 100 the highest.",
      "IV percentile is the share of the past 52 weeks' options closes with IV30 below the latest; IV30 changes are in volatility points (25% to 27% is +2). IV fields with no close in five days are unavailable. HV20 is 20-session realized volatility, annualized, and HV rank places it between its 52-week low and high.",
      "Technical fields (RSI, moving averages, MACD and golden crosses, new highs and lows, Bollinger width) read US listings' completed daily sessions: they describe the last close, not the session in progress. A days-since field counts trading days, 0 at the last session.",
      "Shares outstanding, float, short % of float and institutional ownership cover US filers: the 10-K or 10-Q cover count, the stored statistics float, the FINRA settlement, the 13F quarter. The source does not say when it measured the float, so float and short % of float are partial, dated by when the statistics were retrieved (within 30 days) and never above the dated shares outstanding. A stale or inconsistent input leaves a field unavailable with its reason. Institutional ownership is over the balance-sheet count at the 13F quarter end; over 100% is partial with its reason.",
      "ROIC, FCF yield, net debt / EBITDA and debt / equity read FA's latest annual column: the trailing four quarters, or the fiscal year when those quarters are it. Revenue and EPS CAGRs run from the latest fiscal year back 3 or 5 years, both years from the stored statements or both from the SEC filings (US filers), never one of each. Forward growth is the consensus EE shows for the fiscal year in progress. N/M where FA prints it: EBITDA, equity, invested capital or a base year at or below zero.",
      "Piotroski F-score compares the latest two fiscal years; Altman Z, the Graham number, Lynch fair value, earnings yield and return on capital read FA's latest annual column at today's price and market cap, each dated by its period end. N/M where the score is not defined: Altman Z, the Magic Formula and an unclassified balance sheet's F-score for banks and insurers, the Graham number and Lynch value over a loss. Magic Formula rank and RS rating rank the covered US listings, not the whole market. Streak years run to the first stored year at most, read as at least that many; the distribution history covers about ten years. S&P 500 and Dow membership read the IVV and DIA holdings MEMB reads, 1 for a member.",
      "Value, Growth, Profitability, Momentum and Revisions grades rank a few of these fields within the company's sector, every currency together, and print F to A+ (stored 1 to 13, so B+ or better is gte 10); a company's share classes and lines are graded once, on its most traded line, and a sector with fewer than 20 companies that have them ranks against every company, and the Reason says so. A grade needs two of its inputs; an N/M input is left out. The composite averages the grades' percentiles with equal weights (three grades or more), ranks the averages across every company and prints 1 to 5 with its label: Top, Strong, Neutral, Weak or Bottom, its nearest whole number.",
    ],
  },
  async load(args, ctx) {
    if ([args.options.preset, args.options.saved, args.options.definition].filter(Boolean).length > 1)
      throw new Error(args.options.preset ? "Choose one of --preset, --saved and --definition." : "Choose --saved or --definition, not both.");
    const preset = screenIdea(args.options.preset == null ? undefined : String(args.options.preset));
    let definition = preset?.definition ?? (args.options.definition
      ? readDefinition(String(args.options.definition))
      : DEFAULT_SCREEN);
    let savedName: string | undefined;
    if (args.options.saved) {
      const screens = await fetchSavedScreens(ctx.signal, ctx.apiClient);
      const wanted = String(args.options.saved).trim();
      const byId = screens.find((screen) => screen.id === wanted);
      const matches = byId ? [byId] : screens.filter((screen) => screen.name.toLowerCase() === wanted.toLowerCase());
      if (matches.length !== 1) throw new Error(matches.length
        ? `More than one saved screen is named ${JSON.stringify(wanted)}. Use its ID with --saved.`
        : `Saved screen ${JSON.stringify(wanted)} was not found. Open Saved in EQS to see your screens.`);
      definition = matches[0]!.definition;
      savedName = matches[0]!.name;
    }
    const watchlistRead = await withWatchlistSymbols(definition, ctx);
    definition = watchlistRead.definition;
    if (args.options.check) {
      const data = await fetchScreenCheck(definition, String(args.options.check), undefined, ctx.signal, ctx.apiClient);
      return {
        freshness: { asOf: data.snapshot.assembledAt },
        complete: data.status === "available" && data.warnings.length === 0,
        errors: data.warnings,
        ...(watchlistRead.notes.length ? { notes: watchlistRead.notes } : {}),
        sections: data.criteria.length === 0 ? [{
          title: data.row ? `${data.row.symbol}:${data.row.exchange}` : data.symbol,
          entries: [{ label: "Result", value: screenCheckSummary(data) }],
        }] : [{
          title: `${data.row ? `${data.row.symbol}:${data.row.exchange}` : data.symbol} · ${screenCheckSummary(data)}`,
          columns: [
            { key: "criterion", header: "Criterion" },
            { key: "value", header: "Value", align: "right" as const },
            { key: "result", header: "Result" },
            { key: "asOf", header: "As of" },
            { key: "state", header: "State" },
            { key: "reason", header: "Reason", underRow: true },
          ],
          rows: checkRows(data),
        }],
        metadata: {
          definition: data.definition, snapshot: data.snapshot, symbol: data.symbol,
          listing: data.row, matches: data.matches, status: data.status,
          criteria: data.criteria, ...(savedName ? { savedScreen: savedName } : {}),
        },
      };
    }
    const limit = typeof args.options.limit === "number" ? args.options.limit : SCREEN_PAGE_ROWS;
    const data = await fetchScreenRows(definition, limit, ctx);
    const metrics = readMetrics(args.options.metric == null ? preset ? ideaMetricSetting(preset) : "marketCap" : String(args.options.metric));
    const metric = metrics[0]!;
    // Last, Chg% and market cap are the regular session, as `quote` and the
    // pane read each row's quote; an extended print is a column of its own.
    // A sort on one of them is redone on those figures.
    const rows = sortLiveScreenRows(overlayScreenQuotes(data.rows, await loadRowQuotes(data.rows, ctx)), data.definition.sort);
    const extendedSessions = screenExtendedSessions(rows);
    // A Pro metric the server held back from Free says so once, as KPIS says it; a KPI
    // with gaps says what a gap is, as KPIS does.
    const withheld = rows.some((row) => row.metrics[metric].access === "pro");
    // A locked result is the lock line alone: what the server says of its coverage is of values a Free reader cannot see.
    const errors = withheld ? [withheldMetricNote(metric)] : data.warnings;
    const missing = rows.filter((row) => row.metrics[metric].value === null).length;
    const kpiGaps = !withheld && missing > 0 && (KPI_FIELDS as readonly string[]).includes(metric)
      ? [`${missing} of ${rows.length} ${rows.length === 1 ? "row has" : "rows have"} no ${screenLabel(metric)}. ${KPI_COVERAGE_NOTE}`]
      : [];
    // A category value that names nothing (`Utility` for Utilities) says so with the names it was likely meant as.
    const unmatched = unmatchedCategoryValues(data.definition, data, rows).map(unmatchedCategoryText);
    const unmatchedText = unmatched.length > 0 ? [...unmatched, CATEGORY_NAMES_POINTER].join(" ") : null;
    // A CAD screen of listings quoted in USD is empty for its currency, not for want of companies: say so, and give the screen in USD.
    const currencyEmpty = rows.length === 0 ? screenCurrencyEmpty(data.definition, data.universe) : null;
    const empty = rows.length === 0 && unmatchedText
      ? unmatchedText
      : currencyEmpty
      ? [
        `${currencyEmpty.title} ${currencyEmpty.detail}`,
        `${currencyFallbackLead(currencyEmpty.base.currency!, ctx?.config?.baseCurrency)}: gloom fn EQS --definition '${spacedJson(currencyEmpty.base)}'${metric === "marketCap" ? "" : ` --metric ${metric}`}`,
      ].join("\n")
      : null;
    const ytdBase = screenYtdBase(data.rows, data.snapshot?.assembledAt);
    // The metrics after the first, then the field the rows are sorted by, so the order shown is explained by a column.
    const extra = extraScreenColumns(metrics, data.definition.sort.field);
    const extraMetrics = extra.filter(isNumericField);
    // Last is the first metric's own column when it is the price; otherwise it carries its own date and state.
    const lastShown = metric !== "price";
    // Every State column a row shows: the first metric's, each other metric's, and Last's.
    const stated = [...extraMetrics, ...lastShown ? ["price" as const] : []];
    const states = new Set(rows.flatMap((row) => [row.metrics[metric].state,
      ...stated.flatMap((field) => row.metrics[field] && row.metrics[field].access !== "pro" ? [row.metrics[field].state] : [])]));
    const legend = STATE_LEGEND.filter(({ state }) => states.has(state)).map(({ text }) => text);
    const locked = rows.some((row) => metrics.some((field) => row.metrics[field]?.access === "pro"));
    const notes = [...watchlistRead.notes, ...listingReadNotes(data.listings, data.definition.currency), ...kpiGaps, ...legend,
      ...(locked && !errors.some(isProLock) ? ["Locked figures require Gloom Pro access."] : [])];
    const sortedKey = sortedColumnKey(data.definition.sort.field, metric);
    const mark = data.definition.sort.direction === "desc" ? "▼" : "▲";
    const columns: HeadlessPaneColumn[] = [
      { key: "symbol", header: "Symbol" },
      { key: "exchange", header: "Exchange" },
      { key: "name", header: "Name" },
      // The focus metric says it once when it is the price or the move.
      ...(lastShown ? [{ key: "price", header: "Last", align: "right" as const, format: price }] : []),
      ...(metric === "changePercent" ? [] : [{ key: "changePercent", header: "Chg%", align: "right" as const, format: percent }]),
      ...extendedSessions.map(extendedColumn),
      // When Last and its move are from, and whether that is a current price. Exports write these after their older
      // columns, so none of those moves.
      ...(lastShown ? [
        { key: "priceAsOf", header: "Last as of", textFormat: stampText, optional: true, exportLast: true },
        { key: "priceState", header: "Last state", optional: true, exportLast: true },
      ] : []),
      // YTD names the close it is measured from: `YTD% vs 31 Dec close`.
      { key: "value", header: screenColumnLabel(metric, ytdBase, "report"), align: "right" },
      { key: "unit", header: "Unit" },
      { key: "percentile", header: "Covered pctl", align: "right" },
      { key: "asOf", header: "As of" },
      { key: "state", header: "State" },
      // Every metric after the first is dated and stated on its own, never by the first's columns.
      ...extra.flatMap((field): HeadlessPaneColumn[] => {
        if (!isNumericField(field)) return [{ key: field, header: CATEGORY_HEADERS[field] }];
        const label = screenColumnLabel(field, ytdBase, "report");
        return [
          { key: field, header: label, align: "right" },
          { key: `${field}AsOf`, header: `${label} as of`, literalHeader: true, optional: true, exportLast: true },
          { key: `${field}State`, header: `${label} state`, literalHeader: true, optional: true, exportLast: true },
        ];
      }),
      // Why a row's Last is not a current price, under that row.
      ...(lastShown ? [{ key: "priceNote", header: "Last note", underRow: true, exportLast: true }] : []),
    ];
    // The text report marks the column the rows are ordered by (`(sorted descending)` in plain text); exports name it in Screen.
    const sortedColumn = columns.find((column) => column.key === sortedKey);
    const sortedBy = sortedColumn?.header ?? screenLabel(data.definition.sort.field);
    if (sortedColumn) sortedColumn.textHeader = `${sortedColumn.header} ${mark}`;
    // Payload status also counts ordinary per-field sparsity; only generation
    // warnings are failures, and more pages are not an error.
    return {
      freshness: { asOf: newestInput(data.snapshot) },
      complete: !data.nextCursor && errors.length === 0,
      errors,
      ...(notes.length ? { notes } : {}),
      ...(rows.length > 0 && unmatchedText ? { warnings: [unmatchedText] } : {}),
      sections: [
        // First, so a saved report opens with what it is a screen of and how its rows are ordered.
        { title: "Screen", entries: screenEntries(data, sortedBy, { preset, savedName, metrics }) },
        {
          title: "Matching equities",
          ...(empty ? { empty } : {}),
          columns,
          rows: rows.map((row) => {
            const observation = row.metrics[metric];
            const focus = metricStamp(observation);
            const last = lastStamp(row.metrics.price);
            return {
              symbol: row.symbol,
              exchange: row.exchange,
              name: row.name,
              currency: row.currency,
              price: row.metrics.price.value,
              ...(lastShown ? { priceAsOf: last.at, priceState: last.state } : {}),
              ...row.quotedUnitDivisor ? { quotedUnitDivisor: row.quotedUnitDivisor } : {},
              changePercent: row.metrics.changePercent.value,
              extendedSession: row.extended?.session ?? null,
              extendedPrice: row.extended?.price ?? null,
              extendedChangePercent: row.extended?.changePercent ?? null,
              ...(row.extended?.mark ? { extendedMark: true } : {}),
              value: formatScreenMetric(metric, observation),
              unit: observation.unit,
              percentile:
                observation.percentile.value == null
                  ? null
                  : Math.round(observation.percentile.value),
              asOf: focus.asOf,
              state: focus.state,
              ...Object.fromEntries(extra.flatMap((field): Array<[string, unknown]> => {
                if (!isNumericField(field)) return [[field, row[field]]];
                const own = metricStamp(row.metrics[field]);
                return [[field, extraMetricCell(field, row.metrics[field])], [`${field}AsOf`, own.asOf], [`${field}State`, own.state]];
              })),
              ...(lastShown ? { priceNote: last.note } : {}),
            };
          }),
        },
      ],
      // Per-row metric provenance stays out: 100 annotated rows overflow tool results.
      metadata: {
        snapshot: data.snapshot,
        definition: data.definition,
        matched: data.universe.matched,
        covered: data.universe.covered,
        returned: data.rows.length,
        hasMore: !!data.nextCursor,
        metrics,
        sort: { field: data.definition.sort.field, direction: data.definition.sort.direction, column: sortedBy },
        ...(unmatched.length > 0 ? { unmatchedValues: unmatchedCategoryValues(data.definition, data, rows) } : {}),
        priceBasis: "price, changePercent and the market cap are the regular session, read from each row's quote as `quote` reads it: after the close, its close and that close's move. trailingPE, forwardPE and priceToBook are over that price, as `valuation` reprices them. A pre-market, after-hours or overnight print is in extendedPrice and extendedChangePercent, measured from that close. Membership and percentiles are the snapshot's, which ranks by the close; a sort on price, changePercent, volume, marketCap or those multiples orders these rows by the figures shown.",
        notices: data.nextCursor
          ? [moreMatchesNotice(data.rows.length, data.universe.matched)]
          : [],
      },
    };
  },
};
