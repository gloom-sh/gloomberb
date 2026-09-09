import type { HeadlessPaneDefinition } from "../../../types/headless";

type PaneSchema = Pick<HeadlessPaneDefinition, "argument" | "options" | "discovery">;

export const paneSchemas = {
  "correlation-pane": {
    argument: { kind: "tickers", minimum: 2 },
    options: [
      {
        key: "rangePreset",
        description: "Correlation history window.",
        type: "enum",
        aliases: ["range"],
        values: [
          { value: "1M", aliases: ["month", "monthly"] },
          { value: "3M" },
          { value: "6M" },
          { value: "1Y", aliases: ["year"] },
          { value: "5Y", aliases: ["five-years", "five years"] },
        ],
        defaultValue: "1Y",
        settingKey: "rangePreset",
      },
    ],
    discovery: {
      id: "return-correlation",
      aliases: ["correlation", "return correlation", "correlation matrix", "pearson correlation"],
      limitations: ["Correlation is computed from daily returns with at least five shared observations."],
      screenshotReadiness: "partial",
    },
  },
  "relationship-graph-pane": {
    argument: { kind: "tickers", maximum: 2 },
    options: [
      {
        key: "range",
        description: "Relationship history window.",
        type: "enum",
        aliases: ["rangePreset"],
        values: [
          { value: "1M", aliases: ["month", "monthly"] },
          { value: "3M" },
          { value: "6M" },
          { value: "1Y", aliases: ["year"] },
          { value: "5Y", aliases: ["five-years", "five years"] },
          { value: "ALL", aliases: ["max", "maximum"] },
        ],
        defaultValue: "1Y",
        pluginState: { pluginId: "market-overview" },
      },
      {
        key: "correlationWindow",
        description: "Rolling-correlation window in observations.",
        type: "integer",
        aliases: ["window"],
        defaultValue: 120,
        minimum: 5,
        maximum: 1000,
        pluginState: { pluginId: "market-overview" },
      },
    ],
    discovery: {
      id: "security-relationship",
      aliases: ["relationship", "ratio", "beta", "regression", "rolling correlation"],
      limitations: ["A single ticker is compared with SPY."],
      screenshotReadiness: "partial",
    },
  },
} satisfies Record<string, PaneSchema>;
