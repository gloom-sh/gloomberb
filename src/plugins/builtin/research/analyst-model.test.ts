import { describe, expect, test } from "bun:test";
import type { AnalystRatingRecord, AnalystResearchData, Quote } from "../../../types/financials";
import { analystReferencePrice, analystTargetCurrency, buildAnalystFooterInfo, buildAnalystStatusSegments, buildAnalystTargetHistory, buildRatingColumns, formatAnalystPrice, formatRatingTarget, formatRecommendationMix, latestRecommendation, ratingTargetDelta, recommendationMix, recommendationTotal, sortRatingRows, targetUpside, type RatingSortPreference } from "./analyst-model";
const data: AnalystResearchData = { symbol: "FIX", recommendations: [], ratings: [], earningsEstimates: [], revenueEstimates: [] };
const complete = { period: "current month", strongBuy: 2, buy: 3, hold: 4, sell: 0, strongSell: 0 };

test("unknown and explicit minor units format without a currency or scale guess", () => {
  expect(formatAnalystPrice(0, undefined)).toBe("0.00 (ccy?)");
  expect(formatAnalystPrice(125, "GBp")).toBe("£1.25");
  expect(formatAnalystPrice(1.25, "GBP")).toBe("£1.25");
  expect(formatAnalystPrice(Infinity, "USD")).toBe("-");
  expect(analystTargetCurrency({ ...data, currency: " GBP ", priceTarget: { currency: " " } })).toBe("GBP");
  expect(analystTargetCurrency({ ...data, currency: "USD", priceTarget: { currency: " EUR " } })).toBe("EUR");
  expect(targetUpside({ average: 0, current: 2 })).toBe(-1);
});

test("consensus total requires every finite nonnegative integer bucket", () => {
  expect(recommendationTotal(data)).toBeNull();
  expect(recommendationTotal({ ...data, recommendations: [complete] })).toBe(9);
  for (const strongSell of [undefined, -1, NaN, Infinity, 0.5]) {
    const incomplete = { ...data, recommendations: [{ ...complete, strongSell }] };
    expect(recommendationTotal(incomplete)).toBeNull();
    expect(recommendationMix(incomplete)?.strongSell).toBeNull();
    expect(formatRecommendationMix(incomplete)).toBe("SB 2  B 3  H 4  S -");
  }
  expect(recommendationTotal({ ...data, recommendations: [{ ...complete, strongBuy: 0, buy: 0, hold: 0 }] })).toBe(0);
});

test("status segments name an older mix's period and never claim fresh stale data", () => {
  const research: AnalystResearchData = {
    ...data,
    currency: "USD",
    priceTarget: { current: 467.5, average: 472.17, low: 225, median: 482.5, high: 625, currency: "USD" },
    recommendationRating: 8.8,
    fetchedAt: new Date(Date.now() - 7_200_000).toISOString(),
    recommendations: [complete],
  };
  const text = (research: AnalystResearchData) => buildAnalystStatusSegments(research)
    .map((segment) => segment.parts.map((part) => part.text).join(" ")).join(" · ");

  expect(text(research)).toBe(
    "low $225.00 med $482.50 high $625.00 · rating 8.8/10 · SB 2  B 3  H 4  S 0 9 analysts"
    + " · upside vs $467.50 · fetched 2h ago",
  );
  expect(text({ ...research, recommendations: [{ ...complete, period: "previous month" }] }))
    .toContain("9 analysts (prev month)");
  const stale = text({ ...research, stale: true });
  expect(stale.startsWith("stale · ")).toBe(true);
  expect(stale).not.toContain("fetched");

  // A narrow pane drops whole segments instead of shrinking them into stubs,
  // and a failure keeps its room ahead of the context.
  const info = (width: number, error: string | null = null) =>
    buildAnalystFooterInfo(research, { width, loading: false, error })
      .map((segment) => segment.parts.map((part) => part.text).join(" "));
  expect(info(200)).toHaveLength(5);
  expect(info(60)).toEqual(["low $225.00 med $482.50 high $625.00", "rating 8.8/10"]);
  expect(info(60, "provider down")).toEqual(["provider down", "low $225.00 med $482.50 high $625.00"]);
});

test("rebuilt target history dates one point per publishing day and ages firms out", () => {
  const rating = (date: string, firm: string, currentPriceTarget?: number): AnalystRatingRecord => ({
    date,
    firm,
    ...(currentPriceTarget == null ? {} : { currentPriceTarget }),
    // An undated prior must never reach the mean.
    priorPriceTarget: 999,
  });
  // Newest first, the order the source serves.
  const ratings = [
    rating("2026-05-10", "Zenith", 120),
    rating("2026-05-10", "zenith ", 110),
    rating("2026-05-10", "Beta", 60),
    rating("2026-03-01", "No Target"),
    rating("2026-03-01", "Zenith", 90),
    rating("2026-02-01", "Beta", 30),
    rating("2025-03-01", "Alpha", 300),
  ];

  // Alpha holds its target until it leaves the window before 2026-05-10, and
  // Zenith's two rows of one day collapse into the one served first.
  expect(buildAnalystTargetHistory(ratings, { minFirms: 2 })).toEqual([
    { date: "2026-02-01", average: 165, firms: 2 },
    { date: "2026-03-01", average: 140, firms: 3 },
    { date: "2026-05-10", average: 90, firms: 2 },
  ]);
  expect(buildAnalystTargetHistory(ratings, { minFirms: 3 })).toEqual([
    { date: "2026-03-01", average: 140, firms: 3 },
  ]);
  expect(buildAnalystTargetHistory(ratings, { minFirms: 2, windowDays: 7 })).toEqual([
    { date: "2026-05-10", average: 90, firms: 2 },
  ]);
});

test("explicit current month is selected without inventing an observation date", () => {
  for (const period of ["current month", "current_month", "0m"]) {
    const current = { ...complete, period };
    expect(latestRecommendation({ ...data, recommendations: [{ ...complete, period: "previous month" }, current] })).toBe(current);
  }
  const historical = { ...complete, period: "previous month" };
  expect(latestRecommendation({ ...data, recommendations: [historical] })).toBe(historical);
});

test("upside follows the live price only when it is quoted in the target's currency", () => {
  const research: AnalystResearchData = {
    ...data,
    currency: "USD",
    priceTarget: { current: 100, average: 120, currency: "USD" },
  };
  const quote = (overrides: Partial<Quote>): Quote => ({
    symbol: "FIX", price: 110, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1, dataSource: "live", ...overrides,
  });
  const live = analystReferencePrice(research, quote({}));
  expect(live).toEqual({ price: 110, freshness: "real-time", live: true });
  expect(targetUpside(research.priceTarget, live.price)).toBeCloseTo(120 / 110 - 1);
  expect(analystReferencePrice(research, quote({ dataSource: "delayed" })).freshness).toBe("15m delayed");
  // An ADR quoted in another currency, a pence line or a stale quote keep the provider's reference.
  for (const other of [quote({ currency: "EUR" }), quote({ currency: "GBp" }), quote({ stale: true })]) {
    expect(analystReferencePrice(research, other)).toEqual({ price: 100, freshness: null, live: false });
  }
  const footer = buildAnalystStatusSegments(research, live)
    .find((segment) => segment.id === "analyst-reference-price")!
    .parts.map((part) => part.text).join(" ");
  expect(footer).toBe("upside vs $110.00 real-time");
});

describe("analyst rating sorting", () => {
  const ratings: AnalystRatingRecord[] = [
    {
      date: "2026-05-06",
      firm: "Beta Capital",
      action: "Raises",
      current: "Neutral",
      prior: "Neutral",
      currentPriceTarget: 385,
      priorPriceTarget: 270,
    },
    {
      date: "2026-05-07",
      firm: "Alpha Research",
      action: "Downgrade",
      current: "Hold",
      prior: "Buy",
      currentPriceTarget: 340,
      priorPriceTarget: 335,
    },
    {
      date: "2026-05-06",
      firm: "Zenith",
      action: "Upgrade",
      current: "Buy",
      prior: "Neutral",
      currentPriceTarget: 525,
      priorPriceTarget: 265,
    },
    {
      date: "2026-05-05",
      firm: "No Target",
      action: "Reiterates",
      current: "Buy",
      prior: "Buy",
    },
  ];

  test("sorts date newest first by default", () => {
    const preference: RatingSortPreference = { columnId: "date", direction: "desc" };

    expect(sortRatingRows(ratings, preference).map((row) => row.firm)).toEqual([
      "Alpha Research",
      "Beta Capital",
      "Zenith",
      "No Target",
    ]);
  });

  test("sorts target by current target value with missing targets last", () => {
    const preference: RatingSortPreference = { columnId: "target", direction: "desc" };

    expect(sortRatingRows(ratings, preference).map((row) => row.firm)).toEqual([
      "Zenith",
      "Beta Capital",
      "Alpha Research",
      "No Target",
    ]);
  });

  test("sorts text columns alphabetically with recent dates as a tie-breaker", () => {
    const preference: RatingSortPreference = { columnId: "firm", direction: "asc" };

    expect(sortRatingRows(ratings, preference).map((row) => row.firm)).toEqual([
      "Alpha Research",
      "Beta Capital",
      "No Target",
      "Zenith",
    ]);
  });
});

describe("analyst rating columns", () => {
  test("widens the target column for formatted price target changes", () => {
    const columns = buildRatingColumns(
      [
        {
          date: "2026-04-16",
          firm: "RBC Capital",
          action: "Raises",
          current: "Outperform",
          prior: "Outperform",
          currentPriceTarget: 1725,
          priorPriceTarget: 1625,
        },
      ],
      "USD",
    );

    expect(columns.find((column) => column.id === "target")?.width).toBe(16);
  });

  test("aligns target arrows across mixed price widths", () => {
    const narrowPrior: AnalystRatingRecord = {
      date: "2026-05-01",
      firm: "Alpha",
      action: "Raises",
      current: "Outperform",
      prior: "Outperform",
      currentPriceTarget: 220,
      priorPriceTarget: 9,
    };
    const widePrior: AnalystRatingRecord = {
      date: "2026-05-02",
      firm: "Beta",
      action: "Raises",
      current: "Outperform",
      prior: "Outperform",
      currentPriceTarget: 230,
      priorPriceTarget: 230,
    };
    const targetColumn = buildRatingColumns([narrowPrior, widePrior], "USD")
      .find((column) => column.id === "target");

    expect(formatRatingTarget(narrowPrior, "USD", targetColumn).indexOf("→")).toBe(
      formatRatingTarget(widePrior, "USD", targetColumn).indexOf("→"),
    );
  });

  test("a cached first target's 0 prior reads as no prior target", () => {
    const first: AnalystRatingRecord = { date: "2026-08-04", firm: "China Renaissance", currentPriceTarget: 280, priorPriceTarget: 0 };
    expect(formatRatingTarget(first, "USD")).toBe(" $280");
    expect(ratingTargetDelta(first)).toBeNull();
  });
});
