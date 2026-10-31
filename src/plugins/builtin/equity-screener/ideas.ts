import type { NumericField, ScreenCriterion, ScreenDefinition } from "../../../api-client/equity-screener";

/** A ready screen in the Ideas tab and `--preset`: its definition and the metric it leads with. */
export interface ScreenIdea {
  id: string;
  name: string;
  metric: NumericField;
  definition: ScreenDefinition;
}

/** Companies above 2B, so an idea lists names that trade, not every small listing that moved. */
const TRADED: ScreenCriterion = { field: "marketCap", op: "gte", value: 2_000_000_000 };

const idea = (
  id: string,
  name: string,
  criteria: ScreenCriterion[],
  sort: ScreenDefinition["sort"] & { field: NumericField },
): ScreenIdea => ({
  id,
  name,
  metric: sort.field,
  definition: { version: 1, currency: "USD", criteria: [...criteria, TRADED], sort },
});

/**
 * Technical ideas, read at the last completed session, then fundamental ones, read on `FA`'s bases (the trailing four
 * quarters, or the latest fiscal year when those quarters are that year) and `EE`'s consensus.
 */
export const SCREEN_IDEAS: ScreenIdea[] = [
  idea("oversold-uptrend", "Oversold in an uptrend", [
    { field: "rsi14", op: "lte", value: 30 },
    { field: "priceVsSma200Percent", op: "gt", value: 0 },
  ], { field: "rsi14", direction: "asc" }),
  idea("golden-cross", "Fresh golden cross", [
    { field: "goldenCrossDays", op: "lte", value: 10 },
  ], { field: "goldenCrossDays", direction: "asc" }),
  // Every match is at its high, so the largest companies lead.
  idea("52-week-high", "52-week high breakout", [
    { field: "newHigh52wDays", op: "eq", value: 0 },
  ], { field: "marketCap", direction: "desc" }),
  idea("bollinger-squeeze", "Bollinger squeeze", [
    { field: "bollingerWidthPercentile", op: "lte", value: 5 },
  ], { field: "bollingerWidthPercentile", direction: "asc" }),
  idea("macd-turn", "MACD turns up in an uptrend", [
    { field: "macdBullishCrossDays", op: "lte", value: 3 },
    { field: "priceVsSma200Percent", op: "gt", value: 0 },
  ], { field: "macdBullishCrossDays", direction: "asc" }),
  // A free cash flow yield of 6% or more, about twice the S&P 500's; EV / EBITDA of 10x or less, under the index's
  // long-run 12x or so; net debt within 3x EBITDA, about where investment grade ends, so a cheap price is not a
  // stretched balance sheet. Highest yield first.
  idea("value", "Value", [
    { field: "fcfYieldPercent", op: "gte", value: 6 },
    { field: "evToEbitda", op: "lte", value: 10 },
    { field: "netDebtToEbitda", op: "lte", value: 3 },
  ], { field: "fcfYieldPercent", direction: "desc" }),
  // A return on invested capital of 15% or more, above any company's cost of capital; net debt within 2x EBITDA;
  // revenue compounding at 5% a year or more over five years; free cash flow above zero. Highest return first.
  idea("quality", "Quality", [
    { field: "roicPercent", op: "gte", value: 15 },
    { field: "netDebtToEbitda", op: "lte", value: 2 },
    { field: "revenueCagr5YPercent", op: "gte", value: 5 },
    { field: "fcfYieldPercent", op: "gt", value: 0 },
  ], { field: "roicPercent", direction: "desc" }),
  // Growth at a reasonable price: consensus EPS growth of 10% to 25% for the fiscal year in progress (Peter Lynch's
  // range; faster rarely lasts) on a three-year record of 10% a year or more; a forward P/E of 20x or less, so the
  // price stays within twice the growth; ROIC of 10% or more, so the growth is earned, not a recovery from a loss.
  // Fastest growth first.
  idea("garp", "GARP", [
    { field: "forwardEpsGrowthPercent", op: "between", value: [10, 25] },
    { field: "epsCagr3YPercent", op: "gte", value: 10 },
    { field: "forwardPE", op: "lte", value: 20 },
    { field: "roicPercent", op: "gte", value: 10 },
  ], { field: "forwardEpsGrowthPercent", direction: "desc" }),
];

export const screenIdea = (id: string | undefined): ScreenIdea | undefined =>
  SCREEN_IDEAS.find((entry) => entry.id === id);
