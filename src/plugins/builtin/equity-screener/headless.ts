import type { HeadlessPaneDefinition } from "../../../types/plugin";
import {
  NUMERIC_FIELDS,
  type NumericField,
} from "../../../api-client/equity-screener";
import { fetchScreen } from "./client";
import {
  DEFAULT_SCREEN,
  formatScreenValue,
  metricDate,
  parseScreenDefinition,
  SHORT_LABELS,
} from "./model";

export const equityScreenerHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "none" },
  options: [
    {
      key: "definition",
      type: "string",
      description: "Version 1 JSON screen criteria and sort definition.",
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
      "Covered stored universe, not every listed equity",
      "Ranks are cross-sectional and dates differ by field",
      "Observed-subset insider activity cannot establish an absence",
    ],
  },
  async load(args, ctx) {
    const definition = args.options.definition
      ? parseScreenDefinition(JSON.parse(String(args.options.definition)))
      : DEFAULT_SCREEN;
    const data = await fetchScreen(definition, null, ctx.signal, ctx.apiClient);
    const metric = (args.options.metric ?? "marketCap") as NumericField;
    return {
      complete: data.status === "available" && !data.nextCursor,
      errors: [
        ...data.warnings,
        ...(data.nextCursor
          ? [
              "Additional matching rows require cursor pagination through the Cloud query API or pane.",
            ]
          : []),
      ],
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
      metadata: { ...data },
    };
  },
};
