import { describe, expect, test } from "bun:test";
import type { BrokerPortfolioPerformance } from "../../../types/trading";
import { accountDailyReturns, annualizedVolatility, maxDrawdown } from "./account-returns";
import { brokerPerformanceEvidence } from "./risk-evidence";

function performance(overrides: Partial<BrokerPortfolioPerformance> = {}): BrokerPortfolioPerformance {
  // Twelve trading days, 1% up then 2% down alternating, with a deposit on day 5.
  const points = Array.from({ length: 12 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, "0")}` }))
    .reduce<BrokerPortfolioPerformance["points"]>((rows, point, index) => {
      const previous = rows.at(-1);
      const dailyReturn = index === 0 ? 0 : index % 2 ? 0.01 : -0.02;
      const cumulativeReturn = previous ? (1 + previous.cumulativeReturn!) * (1 + dailyReturn) - 1 : 0;
      const externalFlow = index === 5 ? 500 : 0;
      const value = previous ? previous.value! * (1 + dailyReturn) + externalFlow : 10_000;
      rows.push({ ...point, value, cumulativeReturn, dailyReturn, externalFlow });
      return rows;
    }, []);
  return {
    accountId: "U1",
    source: "cloud",
    period: "1Y",
    currency: "USD",
    fetchedAt: 0,
    measure: "TWR",
    flowBasis: "derived",
    points,
    ...overrides,
  };
}

describe("accountDailyReturns", () => {
  test("rebuilds daily returns from cumulative TWR when no daily figure is given", () => {
    const withoutDaily = performance();
    withoutDaily.points = withoutDaily.points.map(({ dailyReturn: _dailyReturn, ...point }) => point);
    const returns = accountDailyReturns(withoutDaily)!;
    expect(returns).toHaveLength(11);
    expect(returns[0]).toMatchObject({ startDateKey: "2026-09-01", dateKey: "2026-09-02" });
    expect(returns[0]!.value).toBeCloseTo(0.01, 12);
    expect(returns[1]!.value).toBeCloseTo(-0.02, 12);
  });

  test("a money-weighted or monthly series is not treated as daily account returns", () => {
    expect(accountDailyReturns(performance({ measure: "MWR" }))).toBeNull();
    const monthly = performance();
    monthly.points = monthly.points.map((point, index) => ({ ...point, date: `20${String(15 + index).padStart(2, "0")}-01-31` }));
    expect(accountDailyReturns(monthly)).toBeNull();
  });

  test("drawdown compounds from the running peak and volatility annualizes daily spread", () => {
    const returns = accountDailyReturns(performance())!;
    // The peak is the first +1%; the trough follows the fifth -2%, four gains later.
    expect(maxDrawdown(returns)).toBeCloseTo(1.01 ** 4 * 0.98 ** 5 - 1, 12);
    expect(annualizedVolatility(returns)!).toBeGreaterThan(0.2);
  });
});

describe("brokerPerformanceEvidence", () => {
  test("uses the broker's flows, with the opening NAV as the starting investment", () => {
    const evidence = brokerPerformanceEvidence({ id: "broker:ibkr:U1", currency: "USD" }, performance(), new Date("2026-09-30"));
    expect(evidence?.performance?.observations[0]!.externalFlow).toBe(0);
    expect(evidence?.performance?.observations[5]!.externalFlow).toBe(500);
    expect(evidence?.source).toBe("Account history, implied flows");
  });

  test("needs known flows and a matching currency", () => {
    expect(brokerPerformanceEvidence({ id: "p", currency: "USD" }, performance({ flowBasis: undefined }))).toBeNull();
    expect(brokerPerformanceEvidence({ id: "p", currency: "EUR" }, performance(), new Date("2026-09-30"))).toBeNull();
  });
});
