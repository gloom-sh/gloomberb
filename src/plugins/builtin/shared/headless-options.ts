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
