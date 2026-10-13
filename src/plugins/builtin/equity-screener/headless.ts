import type { HeadlessPaneDefinition } from "../../../types/plugin";
import {
  NUMERIC_FIELDS,
  type NumericField,
} from "../../../api-client/equity-screener";
import { fetchScreen } from "./client";
import {
  DEFAULT_SCREEN,
  EXAMPLE_SCREEN_DEFINITION,
  formatScreenValue,
  metricDate,
  parseScreenDefinition,
  screenDefinitionSyntax,
  SHORT_LABELS,
} from "./model";
import type { ScreenDefinition } from "../../../api-client/equity-screener";

/** JSON with a space after each comma and colon, so a wrapped command line breaks between tokens and still pastes. */
const spacedJson = (definition: ScreenDefinition) =>
  JSON.stringify(definition).replace(/([,:])(?=["{[\d-])/g, "$1 ");

/** The `--definition` value of the catalog's worked example, quoted for a shell. */
const EXAMPLE_DEFINITION_OPTION = `--definition '${spacedJson(EXAMPLE_SCREEN_DEFINITION)}'`;

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
            { key: "value", header: SHORT_LABELS[metric], align: "right" },
            { key: "unit", header: "Unit" },
            { key: "percentile", header: "Covered pctl", align: "right" },
            { key: "asOf", header: "As of" },
            { key: "state", header: "State" },
          ],
          rows: data.rows.map((row) => {
            const observation = row.metrics[metric];
            const stamp = metricDate(observation);
            return {
              symbol: row.symbol,
              exchange: row.exchange,
              name: row.name,
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
        notices: data.nextCursor
          ? [
              `Top ${data.rows.length} of ${data.universe.matched} matches; narrow the criteria to see the rest.`,
            ]
          : [],
      },
    };
  },
};
