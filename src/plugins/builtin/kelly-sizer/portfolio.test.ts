import { describe, expect, test } from "bun:test";
import { useRegularMarketSession } from "../../../test-support/market-session";
import { MARGIN_EXCHANGE_RATES, MARGIN_PORTFOLIO, MARGIN_TICKERS, marginQuotes } from "../../../test-support/margin-account";
import { calculatePortfolioSummaryTotals } from "../portfolio-list/metrics";
import { resolveKellyBankroll } from "./portfolio";

describe("resolveKellyBankroll", () => {
  useRegularMarketSession();

  const holdings = () => calculatePortfolioSummaryTotals(
    MARGIN_TICKERS, marginQuotes(), "USD", MARGIN_EXCHANGE_RATES, true, MARGIN_PORTFOLIO.id,
  ).allocationHoldings ?? [];

  test("bets a margin account's equity, and nothing while its account is missing", () => {
    expect(resolveKellyBankroll({ netLiquidation: 1_000_000, brokerPortfolio: true, holdings: holdings(), cashValue: null }))
      .toBe(1_000_000);
    // 1.6M of positions on 1.0M of equity: the positions are no bankroll.
    expect(resolveKellyBankroll({ netLiquidation: null, brokerPortfolio: true, holdings: holdings(), cashValue: null })).toBe(0);
  });

  test("counts a manual portfolio's cash, borrowed or not", () => {
    expect(resolveKellyBankroll({ netLiquidation: null, brokerPortfolio: false, holdings: holdings(), cashValue: -600_000 }))
      .toBe(1_000_000);
    expect(resolveKellyBankroll({ netLiquidation: null, brokerPortfolio: false, holdings: holdings(), cashValue: Number.NaN }))
      .toBe(0);
  });
});
