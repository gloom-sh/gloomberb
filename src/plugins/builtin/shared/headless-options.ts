import type { HeadlessPaneOptionDef, HeadlessPaneOptionValue } from "../../../types/headless";
import { isoDateOption } from "../../../utils/calendar-date";

function enumValues(values: readonly (string | HeadlessPaneOptionValue)[]): HeadlessPaneOptionValue[] {
  return values.map((entry) => (typeof entry === "string" ? { value: entry } : entry));
}

export function enumOption(
  key: string,
  values: readonly (string | HeadlessPaneOptionValue)[],
  options: Omit<HeadlessPaneOptionDef, "key" | "type" | "values">,
): HeadlessPaneOptionDef {
  return { key, type: "enum", values: enumValues(values), ...options };
}

export function intOption(
  key: string,
  options: Omit<HeadlessPaneOptionDef, "key" | "type">,
): HeadlessPaneOptionDef {
  return { key, type: "integer", ...options };
}

export function limitOption(
  options: Omit<HeadlessPaneOptionDef, "key" | "type" | "minimum"> & { minimum?: number },
): HeadlessPaneOptionDef {
  return { key: "limit", type: "integer", minimum: 1, shot: REPORT_ROWS, ...options };
}

export function offsetOption(
  options: Omit<HeadlessPaneOptionDef, "key" | "type" | "minimum"> & { minimum?: number },
): HeadlessPaneOptionDef {
  return { key: "offset", type: "integer", minimum: 0, shot: REPORT_PAGE, ...options };
}

export function dateOption(
  key: string,
  options: Omit<HeadlessPaneOptionDef, "key" | "type"> & { flagName?: string },
): HeadlessPaneOptionDef {
  const { flagName, ...rest } = options;
  return { key, type: "string", placeholder: "date", normalize: (value) => isoDateOption(value, flagName ?? key), ...rest };
}

export function argumentText(argument: string | string[] | null | undefined): string {
  return Array.isArray(argument) ? argument.join(" ") : argument ?? "";
}

export function clampLimit(value: unknown, fallback: number, maximum: number, minimum = 1): number {
  const count = Number(value ?? fallback);
  return Number.isFinite(count) ? Math.min(maximum, Math.max(minimum, Math.floor(count))) : fallback;
}

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
  description: "Keep only the latest N annual or quarterly periods per ticker; a period without a value stays as a gap.",
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
