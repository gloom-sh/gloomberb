import type { HeadlessPaneDefinition } from "../../../types/plugin";
import type { HeadlessPaneColumn, HeadlessPaneContext } from "../../../types/headless";
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
import { formatCurrency, formatPercentRaw } from "../../../utils/format";
import { fetchSavedScreens, fetchScreen, fetchScreenCheck } from "./client";
import { SCREEN_IDEAS, screenIdea } from "./ideas";
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
import {
  appendScreenPage,
  DEFAULT_SCREEN,
  EXAMPLE_SCREEN_DEFINITION,
  formatScreenMetric,
  metricDate,
  parseScreenDefinition,
  screenColumnLabel,
  screenDefinitionSyntax,
  screenCurrencyEmpty,
  screenLabel,
  screenYtdBase,
  withheldMetricNote,
} from "./model";
import type { ScreenDefinition } from "../../../api-client/equity-screener";

/** JSON with a space after each comma and colon, so a wrapped command line breaks between tokens and still pastes. */
const spacedJson = (definition: ScreenDefinition) =>
  JSON.stringify(definition).replace(/([,:])(?=["{[\d-])/g, "$1 ");

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

const price = (value: unknown, row: Record<string, unknown>) =>
  typeof value === "number" && typeof row.currency === "string" && row.currency ? formatCurrency(value, row.currency) : "-";
const percent = (value: unknown) => typeof value === "number" ? formatPercentRaw(value) : "-";

/** The pre-market, after-hours or overnight print and its move from the close in Last, for the rows that have one. */
function extendedColumn(session: ExtendedSession): HeadlessPaneColumn {
  return {
    key: "extendedPrice",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right",
    format: (value, row) => row.extendedSession === session && typeof value === "number"
      ? `${price(value, row)}${row.extendedMark ? " mid" : ""} ${percent(row.extendedChangePercent)}`
      : "-",
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
/** Columns every report prints, so the sort field is not added again for them. */
const ALWAYS_SHOWN = new Set(["symbol", "exchange", "name", "price", "changePercent"]);

/**
 * The columns a report adds after the first metric's: the other metrics
 * asked for, then the field the screen is sorted by, so the order of the
 * rows is explained by a column (P/E focus, sorted by dividend yield).
 */
function extraScreenColumns(metrics: readonly NumericField[], sortField: string): Array<NumericField | ShownCategory> {
  const sort = ALWAYS_SHOWN.has(sortField) ? [] : [sortField as NumericField | ShownCategory];
  return [...new Set([...metrics.slice(1), ...sort])].filter((field) => field !== metrics[0]);
}

/** Another metric's cell: its value as the focus column prints it, with the currency of a money value. */
function extraMetricCell(field: NumericField, metric: ScreenMetric | undefined): string {
  if (!metric) return "-";
  if (metric.access === "pro") return "locked";
  const value = formatScreenMetric(field, metric);
  return metric.value != null && /^[A-Z]{3}$/.test(metric.unit) ? `${value} ${metric.unit}` : value;
}

/** What the State column's words mean, said once under a report whose first metric has them. */
const STATE_LEGEND: ReadonlyArray<{ state: ScreenMetric["state"]; text: string }> = [
  { state: "partial", text: "A partial State means the source gives no date for the figure, so As of is when it was collected, or that it covers part of what it measures." },
  { state: "stale", text: "A stale State means the figure is older than its field allows, such as a quote over 4 days old or fundamentals collected over 7 days ago." },
];

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
    if (args.options.check) {
      const data = await fetchScreenCheck(definition, String(args.options.check), undefined, ctx.signal, ctx.apiClient);
      return {
        freshness: { asOf: data.snapshot.assembledAt },
        complete: data.status === "available" && data.warnings.length === 0,
        errors: data.warnings,
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
    const metrics = readMetrics(args.options.metric == null ? preset?.metric ?? "marketCap" : String(args.options.metric));
    const metric = metrics[0]!;
    // Last, Chg% and market cap are the regular session, as `quote` and the
    // pane read each row's quote; an extended print is a column of its own.
    // A sort on one of them is redone on those figures.
    const rows = sortLiveScreenRows(overlayScreenQuotes(data.rows, await loadRowQuotes(data.rows, ctx)), data.definition.sort);
    const extendedSessions = screenExtendedSessions(rows);
    // A Pro metric the server held back from Free says so once, as KPIS says it; a KPI
    // with gaps says what a gap is, as KPIS does.
    const withheld = rows.some((row) => row.metrics[metric].access === "pro");
    const errors = withheld ? [...data.warnings, withheldMetricNote(metric)] : data.warnings;
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
        `In the base currency, ${currencyEmpty.base.currency}: gloom fn EQS --definition '${spacedJson(currencyEmpty.base)}'${metric === "marketCap" ? "" : ` --metric ${metric}`}`,
      ].join("\n")
      : null;
    const ytdBase = screenYtdBase(data.rows, data.snapshot?.assembledAt);
    // The metrics after the first, then the field the rows are sorted by, so the order shown is explained by a column.
    const extra = extraScreenColumns(metrics, data.definition.sort.field);
    const states = new Set(rows.map((row) => row.metrics[metric].state));
    const legend = STATE_LEGEND.filter(({ state }) => states.has(state)).map(({ text }) => text);
    const notes = [...kpiGaps, ...legend];
    // Payload status also counts ordinary per-field sparsity; only generation
    // warnings are failures, and more pages are not an error.
    return {
      freshness: { asOf: data.snapshot?.sourceNewestAt ?? null },
      complete: !data.nextCursor && errors.length === 0,
      errors,
      ...(notes.length ? { notes } : {}),
      ...(rows.length > 0 && unmatchedText ? { warnings: [unmatchedText] } : {}),
      sections: [
        {
          title: "Matching equities",
          ...(empty ? { empty } : {}),
          columns: [
            { key: "symbol", header: "Symbol" },
            { key: "exchange", header: "Exchange" },
            { key: "name", header: "Name" },
            // The focus metric says it once when it is the price or the move.
            ...(metric === "price" ? [] : [{ key: "price", header: "Last", align: "right" as const, format: price }]),
            ...(metric === "changePercent" ? [] : [{ key: "changePercent", header: "Chg%", align: "right" as const, format: percent }]),
            ...extendedSessions.map(extendedColumn),
            // YTD names the close it is measured from: `YTD% vs 31 Dec close`.
            { key: "value", header: screenColumnLabel(metric, ytdBase, "report"), align: "right" },
            { key: "unit", header: "Unit" },
            { key: "percentile", header: "Covered pctl", align: "right" },
            { key: "asOf", header: "As of" },
            { key: "state", header: "State" },
            ...extra.map((field): HeadlessPaneColumn => isNumericField(field)
              ? { key: field, header: screenColumnLabel(field, ytdBase, "report"), align: "right" }
              : { key: field, header: CATEGORY_HEADERS[field] }),
          ],
          rows: rows.map((row) => {
            const observation = row.metrics[metric];
            const stamp = metricDate(observation);
            return {
              symbol: row.symbol,
              exchange: row.exchange,
              name: row.name,
              currency: row.currency,
              price: row.metrics.price.value,
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
              asOf: stamp.collected ? `${stamp.text} (collected)` : stamp.text,
              state: observation.access === "pro" ? "locked" : observation.state,
              ...Object.fromEntries(extra.map((field) => [field, isNumericField(field)
                ? extraMetricCell(field, row.metrics[field])
                : row[field]])),
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
        ...(unmatched.length > 0 ? { unmatchedValues: unmatchedCategoryValues(data.definition, data, rows) } : {}),
        priceBasis: "price, changePercent and the market cap are the regular session, read from each row's quote as `quote` reads it: after the close, its close and that close's move. A pre-market, after-hours or overnight print is in extendedPrice and extendedChangePercent, measured from that close. Membership and percentiles are the snapshot's, which ranks by the close; a sort on price, changePercent, volume or marketCap orders these rows by the figures shown.",
        notices: data.nextCursor
          ? [moreMatchesNotice(data.rows.length, data.universe.matched)]
          : [],
      },
    };
  },
};
