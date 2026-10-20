import type { HeadlessPaneOptionDef, HeadlessPaneOptionValue } from "../../../types/headless";

export const HISTORY_RANGE_VALUES: HeadlessPaneOptionValue[] = [
  { value: "1D", aliases: ["day", "daily"] },
  { value: "1W", aliases: ["week", "weekly"] },
  { value: "1M", aliases: ["month", "monthly"] },
  { value: "3M" },
  { value: "6M" },
  { value: "1Y", aliases: ["year"] },
  { value: "5Y", aliases: ["five-years", "five years"] },
  { value: "ALL", aliases: ["max", "maximum"] },
];

/**
 * The history windows and YTD, which runs from the prior year's last close
 * (the one year-to-date returns are measured from), for a chart that compares
 * returns.
 */
export const RETURN_RANGE_VALUES: HeadlessPaneOptionValue[] = [
  ...HISTORY_RANGE_VALUES.slice(0, 5),
  { value: "YTD", aliases: ["year-to-date", "year to date"] },
  ...HISTORY_RANGE_VALUES.slice(5),
];

export const FINANCIAL_PERIOD_OPTION: HeadlessPaneOptionDef = {
  key: "period",
  description: "Financial reporting period.",
  type: "enum",
  aliases: ["financialPeriod"],
  values: [
    { value: "annual", aliases: ["a", "ann", "year", "yearly", "fy"] },
    { value: "quarterly", aliases: ["q", "qtr", "quarter"] },
  ],
  defaultValue: "annual",
};

export const FINANCIAL_PERIOD_COUNT_OPTION: HeadlessPaneOptionDef = {
  key: "periods",
  description: "Keep only the latest N annual or quarterly observations per ticker.",
  type: "integer",
  aliases: ["years", "limit"],
  minimum: 1,
  maximum: 40,
};

/**
 * `shot` refusals (`HeadlessPaneOptionDef.shot`) for the options only the
 * report reads: how many rows it prints, and where its page starts. The pane
 * lists every row it loads and loads more as it scrolls.
 */
export const REPORT_ROWS = { reportOnly: "sets how many rows the text report prints" };
export const REPORT_PAGE = { reportOnly: "pages the text report" };
export const REPORT_FILTER = { reportOnly: "filters the text report, and the pane opens unfiltered" };
export const REPORT_SORT = { reportOnly: "orders the text report, and the pane opens in its own order" };
