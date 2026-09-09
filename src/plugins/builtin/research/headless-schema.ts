import type { HeadlessPaneDefinition } from "../../../types/headless";

type PaneSchema = Pick<HeadlessPaneDefinition, "argument" | "options" | "discovery">;

export const paneSchemas = {
  "relative-valuation-pane": {
    argument: { kind: "tickers" },
    options: [],
    discovery: {
      id: "relative-valuation",
      aliases: ["relative valuation", "peer valuation", "valuation comps", "compare multiples"],
      limitations: ["Uses current provider fundamentals rather than a historical series."],
      screenshotReadiness: "partial",
    },
  },
} satisfies Record<string, PaneSchema>;
