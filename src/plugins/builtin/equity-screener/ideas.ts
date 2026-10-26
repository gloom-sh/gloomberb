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

/** Technical ideas, read at the last completed session. */
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
];

export const screenIdea = (id: string | undefined): ScreenIdea | undefined =>
  SCREEN_IDEAS.find((entry) => entry.id === id);
