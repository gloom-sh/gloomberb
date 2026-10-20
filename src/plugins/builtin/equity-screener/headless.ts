import type { HeadlessPaneDefinition } from "../../../types/plugin";
import type { HeadlessPaneColumn, HeadlessPaneContext } from "../../../types/headless";
import {
  NUMERIC_FIELDS,
  type NumericField,
  type ScreenRow,
} from "../../../api-client/equity-screener";
import { EXTENDED_SESSION_LABELS, type ExtendedSession } from "../../../market-data/market/status";
import { buildQuoteKey } from "../../../market-data/selectors";
import type { Quote } from "../../../types/financials";
import { formatCurrency, formatPercentRaw } from "../../../utils/format";
import { fetchScreen } from "./client";
import { overlayScreenQuotes, screenExtendedSessions, sortLiveScreenRows } from "./live";
import {
  DEFAULT_SCREEN,
  EXAMPLE_SCREEN_DEFINITION,
  formatScreenValue,
  metricDate,
  parseScreenDefinition,
  screenColumnLabel,
  screenDefinitionSyntax,
  screenYtdBase,
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
    const definition = args.options.definition
      ? readDefinition(String(args.options.definition))
      : DEFAULT_SCREEN;
    const data = await fetchScreen(definition, null, ctx.signal, ctx.apiClient);
    const metric = (args.options.metric ?? "marketCap") as NumericField;
    // Last, Chg% and market cap are the regular session, as `quote` and the
    // pane read each row's quote; an extended print is a column of its own.
    // A sort on one of them is redone on those figures.
    const rows = sortLiveScreenRows(overlayScreenQuotes(data.rows, await loadRowQuotes(data.rows, ctx)), data.definition.sort);
    const extendedSessions = screenExtendedSessions(rows);
    // Payload status also counts ordinary per-field sparsity; only generation
    // warnings are failures, and more pages are not an error.
    return {
      freshness: { asOf: data.snapshot?.sourceNewestAt ?? null },
      complete: !data.nextCursor && data.warnings.length === 0,
      errors: data.warnings,
      sections: [
        {
          title: "Matching equities",
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
              value: formatScreenValue(metric, observation.value),
              unit: observation.unit,
              percentile:
                observation.percentile.value == null
                  ? null
                  : Math.round(observation.percentile.value),
              asOf: stamp.collected ? `${stamp.text} (collected)` : stamp.text,
              state: observation.state,
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
