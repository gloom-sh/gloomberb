import { describe, expect, test } from "bun:test";
import type { AnalystRatingRecord, AnalystResearchData, Quote } from "../../../types/financials";
import { analystReferenceMetadata, analystReferencePrice, analystTargetCurrency, analystUpside, buildAnalystFooterInfo, buildAnalystStatusSegments, buildAnalystTargetHistory, buildMeanTargetHistory, buildRatingColumns, formatAnalystPrice, formatAnalystReference, formatRatingTarget, formatRecommendationMix, latestRecommendation, ratingReason, ratingReasonSource, ratingSplit, ratingTargetDelta, recommendationMix, recommendationTotal, sortRatingRows, targetUpside, type RatingSortPreference } from "./analyst-model";
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

  // The Buy/Hold/Sell split is a figure above the chart, not a footer segment.
  expect(text(research)).toBe(
    "low $225.00 med $482.50 high $625.00 · rating 8.8/10 · upside vs $467.50 provider ref · fetched 2h ago",
  );
  expect(ratingSplit(research)).toEqual({ buy: 5, hold: 4, sell: 0, period: null });
  expect(ratingSplit({ ...research, recommendations: [{ ...complete, period: "previous month" }] })?.period)
    .toBe("prev month");
  expect(ratingSplit({ ...research, recommendations: [{ ...complete, strongSell: undefined }] })).toBeNull();
  const stale = text({ ...research, stale: true });
  expect(stale.startsWith("stale · ")).toBe(true);
  expect(stale).not.toContain("fetched");

  // A narrow pane drops whole segments instead of shrinking them into stubs,
  // and a failure keeps its room ahead of the context.
  const info = (width: number, error: string | null = null) =>
    buildAnalystFooterInfo(research, { width, loading: false, error })
      .map((segment) => segment.parts.map((part) => part.text).join(" "));
  expect(info(200)).toHaveLength(4);
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
  expect(live).toMatchObject({ price: 110, freshness: "real-time", live: true, close: false });
  expect(targetUpside(research.priceTarget, live.price)).toBeCloseTo(120 / 110 - 1);
  expect(analystReferencePrice(research, quote({ dataSource: "delayed" })).freshness).toBe("15m delayed");
  // After the close the upside is from the close, not the after-hours print the quote's price carries.
  expect(analystReferencePrice(research, quote({ price: 112, marketState: "POST", regularClose: 110, regularChange: 1 })).price).toBe(110);
  // An ADR quoted in another currency, a pence line or a stale quote keep the provider's reference.
  for (const other of [quote({ currency: "EUR" }), quote({ currency: "GBp" }), quote({ stale: true })]) {
    expect(analystReferencePrice(research, other)).toMatchObject({ price: 100, freshness: null, live: false });
  }
  const footer = buildAnalystStatusSegments(research, live)
    .find((segment) => segment.id === "analyst-reference-price")!
    .parts.map((part) => part.text).join(" ");
  expect(footer).toBe("upside vs $110.00 real-time");
});

// DUOL before the open on Fri 23 Oct 2026: research fetched after Wednesday's 137.32 close, Last the 141.39
// Thursday close. `analyst` printed -1.40% from the stale reference; from Last it is -4.24%.
test("the upside is measured from Last and says which price and when, for analyst and fn ANR alike", () => {
  const research: AnalystResearchData = {
    ...data,
    currency: "USD",
    fetchedAt: "2026-10-21T21:30:00.000Z",
    priceTarget: { current: 137.32, average: 135.4, median: 137.5, low: 80, high: 210, currency: "USD" },
  };
  const quote: Quote = {
    symbol: "DUOL", price: 140.59, change: -0.8, changePercent: -0.57, currency: "USD", dataSource: "delayed",
    lastUpdated: Date.parse("2026-10-23T12:05:00Z"), marketState: "PRE", exchangeName: "NASDAQ", listingExchangeName: "NASDAQ",
    previousClose: 141.39, regularClose: 141.39, regularCloseSessionDate: "2026-10-22", regularChange: 4.07,
    regularChangePercent: 2.96, preMarketPrice: 140.59, changeSessionDate: "2026-10-23",
  };
  const { upside, reference } = analystUpside(research, quote);
  expect(upside).toBeCloseTo(135.4 / 141.39 - 1, 6);
  const now = Date.parse("2026-10-23T12:05:00Z");
  expect(formatAnalystReference(reference, "USD", now)).toBe("$141.39, Thu 22 Oct close");
  // The ANR pane's status bar names the same price and close.
  const footer = buildAnalystStatusSegments(research, reference, now)
    .find((segment) => segment.id === "analyst-reference-price")!.parts.map((part) => part.text).join(" ");
  expect(footer).toBe("upside vs $141.39 Thu 22 Oct close");
  expect(analystReferenceMetadata(reference)).toEqual({
    price: 141.39, asOf: "2026-10-22T20:00:00.000Z", basis: "regular session close", freshness: "15m delayed",
  });
  // Without a quote it is the provider's reference, and says so.
  const fallback = analystUpside(research, null);
  expect(fallback.upside).toBeCloseTo(135.4 / 137.32 - 1, 6);
  expect(formatAnalystReference(fallback.reference, "USD", now)).toBe("$137.32, provider reference at retrieval Wed 21 Oct 21:30 UTC");
  // While the session trades, the print's time and feed.
  const open = analystUpside(research, { ...quote, marketState: "REGULAR", price: 142.1, lastUpdated: Date.parse("2026-10-23T14:05:00Z"),
    regularClose: undefined, regularCloseSessionDate: undefined, preMarketPrice: undefined, previousClose: 141.39 });
  expect(formatAnalystReference(open.reference, "USD", now)).toBe("$142.10, Fri 23 Oct 14:05 UTC (15m delayed)");
});

test("the mean-target line starts once five firms, or every covering firm, are in it", () => {
  const rating = (date: string, firm: string, currentPriceTarget: number) => ({ date, firm, currentPriceTarget });
  const eight = Array.from({ length: 8 }, (_, index) => rating(`2026-03-${String(10 + index).padStart(2, "0")}`, `Firm ${index}`, 100 + index * 10));
  const line = buildMeanTargetHistory(eight);
  expect(line[0]).toEqual({ date: "2026-03-14", average: 120, firms: 5 });
  expect(line.at(-1)).toEqual({ date: "2026-03-17", average: 135, firms: 8 });
  // Three firms cover the stock, so the line starts when all three are in.
  expect(buildMeanTargetHistory(eight.slice(0, 3))).toEqual([{ date: "2026-03-12", average: 110, firms: 3 }]);
  expect(buildMeanTargetHistory([])).toEqual([]);
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

/**
 * A reason is the line public coverage of the action quotes, with the
 * article. The table only grows a column for it when some action has one.
 */
describe("analyst action reasons", () => {
  const plain: AnalystRatingRecord = { date: "2026-10-29", firm: "TD Cowen", action: "Lowers", current: "Buy", currentPriceTarget: 140, priorPriceTarget: 160 };
  const reasoned: AnalystRatingRecord = {
    ...plain,
    reason: { text: "on weak guidance", url: "https://www.investing.com/news/analyst-ratings/td-cowen-lowers-boot-barn-93CH-1", source: "Investing.com" },
  };

  test("a history with no reason keeps the columns it had", () => {
    expect(buildRatingColumns([plain], "USD").map((column) => column.id)).toEqual(["date", "firm", "action", "current", "target", "prior"]);
    const columns = buildRatingColumns([plain, reasoned], "USD");
    expect(columns.map((column) => column.id)).toEqual(["date", "firm", "action", "current", "target", "prior", "reason"]);
    expect(columns.at(-1)).toMatchObject({ label: "REASON", flexGrow: 1 });
  });

  test("a reason without its line or its article is no reason", () => {
    expect(ratingReason(reasoned)?.text).toBe("on weak guidance");
    expect(ratingReason({ ...plain, reason: { text: " ", url: "https://example.com/a" } })).toBeNull();
    expect(ratingReason({ ...plain, reason: { text: "on weak guidance", url: "" } })).toBeNull();
  });

  test("the source is the publisher, else the article's site", () => {
    expect(ratingReasonSource(reasoned.reason!)).toBe("Investing.com");
    expect(ratingReasonSource({ text: "on weak guidance", url: "https://www.example.com/story" })).toBe("example.com");
  });
});
