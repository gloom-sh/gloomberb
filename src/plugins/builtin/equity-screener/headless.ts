import type { HeadlessPaneDefinition } from "../../../types/plugin";
import type { HeadlessPaneColumn, HeadlessPaneContext } from "../../../types/headless";
import {
  KPI_FIELDS,
  NUMERIC_FIELDS,
  type NumericField,
  type ScreenRow,
} from "../../../api-client/equity-screener";
import { KPI_COVERAGE_NOTE } from "../company-kpis/model";
import { EXTENDED_SESSION_LABELS, type ExtendedSession } from "../../../market-data/market/status";
import { buildQuoteKey } from "../../../market-data/selectors";
import type { Quote } from "../../../types/financials";
import { formatCurrency, formatPercentRaw } from "../../../utils/format";
import { fetchSavedScreens, fetchScreen, fetchScreenCheck } from "./client";
import { checkRows, screenCheckSummary, screenCheckTicker } from "./screen-check";
import { overlayScreenQuotes, screenExtendedSessions, sortLiveScreenRows } from "./live";
import {
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

/** A typed `--definition`, checked; every error points at the worked example. */
function readDefinition(text: string): ScreenDefinition {
  const pointer = "The example in gloomberb catalog EQS is a valid definition to start from.";
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
      description:
        "Metric to display with its source date and covered-universe rank.",
      values: NUMERIC_FIELDS.map((value) => ({ value })),
      defaultValue: "marketCap",
    },
  ],
  describe: "Equity screener",
  discovery: {
    aliases: ["EQS"],
    dataRequirements: ["Gloom Cloud stored screener snapshot"],
    limitations: [
      "Covered stored universe, not every listed equity.",
      "Ranks are cross-sectional and dates differ by field.",
      "Observed-subset insider activity cannot establish an absence.",
      "ATR% is the 14-session average true range as a percent of the last close, for US listings with at least 15 completed daily sessions.",
      "IV rank is a rank, not an IV percentile: 0 is the lowest 30-day implied volatility of the past 52 weeks and 100 the highest.",
    ],
  },
  async load(args, ctx) {
    if (args.options.saved && args.options.definition) throw new Error("Choose --saved or --definition, not both.");
    let definition = args.options.definition
      ? readDefinition(String(args.options.definition))
      : DEFAULT_SCREEN;
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
    const data = await fetchScreen(definition, null, ctx.signal, ctx.apiClient);
    const metric = (args.options.metric ?? "marketCap") as NumericField;
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
    // A CAD screen of listings quoted in USD is empty for its currency, not for want of companies: say so, and give the screen in USD.
    const currencyEmpty = rows.length === 0 ? screenCurrencyEmpty(data.definition, data.universe) : null;
    const empty = currencyEmpty
      ? [
        `${currencyEmpty.title} ${currencyEmpty.detail}`,
        `In the base currency, ${currencyEmpty.base.currency}: gloomberb fn EQS --definition '${spacedJson(currencyEmpty.base)}'${metric === "marketCap" ? "" : ` --metric ${metric}`}`,
      ].join("\n")
      : null;
    // Payload status also counts ordinary per-field sparsity; only generation
    // warnings are failures, and more pages are not an error.
    return {
      freshness: { asOf: data.snapshot?.sourceNewestAt ?? null },
      complete: !data.nextCursor && errors.length === 0,
      errors,
      ...(kpiGaps.length ? { notes: kpiGaps } : {}),
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
            { key: "value", header: screenColumnLabel(metric, screenYtdBase(data.rows, data.snapshot?.assembledAt), "report"), align: "right" },
            { key: "unit", header: "Unit" },
            { key: "percentile", header: "Covered pctl", align: "right" },
            { key: "asOf", header: "As of" },
            { key: "state", header: "State" },
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
        priceBasis: "price, changePercent and the market cap are the regular session, read from each row's quote as `quote` reads it: after the close, its close and that close's move. A pre-market, after-hours or overnight print is in extendedPrice and extendedChangePercent, measured from that close. Membership and percentiles are the snapshot's, which ranks by the close; a sort on price, changePercent, volume or marketCap orders these rows by the figures shown.",
        notices: data.nextCursor
          ? [
              `Top ${data.rows.length} of ${data.universe.matched} matches; narrow the criteria to see the rest.`,
            ]
          : [],
      },
    };
  },
};
