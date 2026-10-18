import type { HeadlessPaneDefinition } from "../../../types/headless";
import { EXTRA_COLUMN_IDS, normalizeExtraColumns } from "./relative-valuation-columns";
import { normalizeCapCurrency } from "./relative-valuation-currency";

type PaneSchema = Pick<HeadlessPaneDefinition, "argument" | "options" | "discovery">;

export const paneSchemas = {
  "relative-valuation-pane": {
    argument: { kind: "tickers" },
    options: [
      {
        key: "peers",
        type: "boolean",
        settingKey: "autoPeers",
        description: "With one symbol, add 4 to 6 competitors: the covered equities in its industry closest in market cap (an education company filed under software is compared with education companies, and an online learning company with its curated core first), or a curated list when too few are covered. The header names the method",
        example: "--peers",
      },
      {
        key: "columns",
        shot: { reportOnly: "adds columns to the text report, and the pane keeps its own" },
        type: "string",
        settingKey: "extraColumns",
        placeholder: "fields",
        description: `Report columns to add, in order: ${EXTRA_COLUMN_IDS.join(", ")}. shortInterest is FINRA short interest as a percent of float at the latest settlement, `
          + "nextEarnings the next report date on the earnings calendar, target the mean analyst target and the analyst count, grossMargin and evEbitda the screener's stored figures. "
          + "Short interest, earnings dates, gross margin and EV/EBITDA cover US listings. CSV and JSON give each cell's source and as-of. The pane keeps its own columns",
        example: "--columns shortInterest,nextEarnings,target,grossMargin,evEbitda",
        normalize: normalizeExtraColumns,
      },
      {
        key: "currency",
        type: "string",
        settingKey: "capCurrency",
        placeholder: "ISO code",
        description: "Show every market cap in this currency, converted at the app's FX rates; the status line names each rate and its time",
        example: "--currency USD",
        normalize: normalizeCapCurrency,
      },
    ],
    discovery: {
      id: "relative-valuation",
      aliases: ["relative valuation", "peer valuation", "valuation comps", "compare multiples"],
      limitations: ["Uses current provider fundamentals rather than a historical series.",
        "Outside the regular session Last, Chg% and the figures measured at the price (market cap, P/E, EV/S, FCF yield) are at the last regular close; a pre-market or after-hours print is shown beside it and never enters them."],
      screenshotReadiness: "partial",
    },
  },
} satisfies Record<string, PaneSchema>;
