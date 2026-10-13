import type { HeadlessPaneDefinition } from "../../../types/headless";

type PaneSchema = Pick<HeadlessPaneDefinition, "argument" | "options" | "discovery">;

export const paneSchemas = {
  "relative-valuation-pane": {
    argument: { kind: "tickers" },
    options: [],
    discovery: {
      id: "relative-valuation",
      aliases: ["relative valuation", "peer valuation", "valuation comps", "compare multiples"],
      limitations: ["Uses current provider fundamentals rather than a historical series.",
        "Outside the regular session Last, Chg% and the figures measured at the price (market cap, P/E, EV/S, FCF yield) are at the last regular close; a pre-market or after-hours print is shown beside it and never enters them."],
      screenshotReadiness: "partial",
    },
  },
} satisfies Record<string, PaneSchema>;
