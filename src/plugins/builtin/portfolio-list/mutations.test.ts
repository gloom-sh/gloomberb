import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import {
  createManualPortfolio,
  deleteManualPortfolio,
  isManualPortfolio,
  removeTickerFromPortfolio,
  resolveManualPositionCurrency,
  setManualPortfolioPosition,
} from "./mutations";

function makeTicker(overrides: Partial<TickerRecord["metadata"]> = {}): TickerRecord {
  return {
    metadata: {
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple Inc.",
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
      ...overrides,
    },
  };
}

describe("portfolio-list mutations", () => {
  test("identifies manual portfolios", () => {
    const config = createDefaultConfig("/tmp/gloomberb-mutations");
    expect(isManualPortfolio(config.portfolios[0]!)).toBe(true);
    expect(isManualPortfolio({
      id: "broker:ibkr",
      name: "IBKR",
      currency: "USD",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-live",
    })).toBe(false);
  });

  test("rejects duplicate manual portfolio names", () => {
    const config = createDefaultConfig("/tmp/gloomberb-mutations");
    expect(() => createManualPortfolio(config, "Main Portfolio", config.baseCurrency)).toThrow('Portfolio "Main Portfolio" already exists.');
  });

  test("deletes a manual portfolio and cleans memberships plus positions", () => {
    const config = createDefaultConfig("/tmp/gloomberb-mutations");
    config.portfolios.push({ id: "research", name: "Research", currency: "USD" });

    const firstTicker = makeTicker({
      ticker: "AAPL",
      portfolios: ["research"],
      positions: [{
        portfolio: "research",
        shares: 10,
        avgCost: 180,
        currency: "USD",
        broker: "manual",
      }],
    });
    const secondTicker = makeTicker({
      ticker: "MSFT",
      portfolios: ["research", "main"],
      positions: [{
        portfolio: "research",
        shares: 5,
        avgCost: 300,
        currency: "USD",
        broker: "manual",
      }, {
        portfolio: "main",
        shares: 3,
        avgCost: 200,
        currency: "USD",
        broker: "manual",
      }],
    });

    const result = deleteManualPortfolio(config, [firstTicker, secondTicker], "research");

    expect(result.config.portfolios.map((portfolio) => portfolio.id)).toEqual(["main"]);
    expect(result.cleanedTickerCount).toBe(2);
    expect(result.removedPositionCount).toBe(2);
    expect(result.tickers).toEqual([
      makeTicker({
        ticker: "AAPL",
        portfolios: [],
      }),
      makeTicker({
        ticker: "MSFT",
        portfolios: ["main"],
        positions: [{
          portfolio: "main",
          shares: 3,
          avgCost: 200,
          currency: "USD",
          broker: "manual",
        }],
      }),
    ]);
  });

  test("removing a ticker from a portfolio also removes its positions", () => {
    const ticker = makeTicker({
      portfolios: ["main", "research"],
      positions: [{
        portfolio: "research",
        shares: 4,
        avgCost: 100,
        currency: "USD",
        broker: "manual",
      }, {
        portfolio: "main",
        shares: 1,
        avgCost: 90,
        currency: "USD",
        broker: "manual",
      }],
    });

    const result = removeTickerFromPortfolio(ticker, "research");

    expect(result.changed).toBe(true);
    expect(result.removedPositionCount).toBe(1);
    expect(result.ticker.metadata.portfolios).toEqual(["main"]);
    expect(result.ticker.metadata.positions).toEqual([{
      portfolio: "main",
      shares: 1,
      avgCost: 90,
      currency: "USD",
      broker: "manual",
    }]);
  });

  test("setting a manual position replaces the aggregate entry for that portfolio", () => {
    const ticker = makeTicker({
      portfolios: ["main"],
      positions: [{
        portfolio: "main",
        shares: 1,
        avgCost: 100,
        currency: "USD",
        broker: "manual",
      }, {
        portfolio: "other",
        shares: 2,
        avgCost: 50,
        currency: "USD",
        broker: "manual",
      }],
    });

    const result = setManualPortfolioPosition(ticker, "main", {
      shares: 10,
      avgCost: 150,
      currency: "USD",
    });

    expect(result.addedMembership).toBe(false);
    expect(result.replacedPositionCount).toBe(1);
    expect(result.ticker.metadata.portfolios).toEqual(["main"]);
    expect(result.ticker.metadata.positions).toEqual([{
      portfolio: "other",
      shares: 2,
      avgCost: 50,
      currency: "USD",
      broker: "manual",
    }, {
      portfolio: "main",
      shares: 10,
      avgCost: 150,
      currency: "USD",
      broker: "manual",
    }]);
  });

  test("split reconciliation preserves a single acquisition date without retaining stale valuation", () => {
    const position = { portfolio: "main", shares: 10, avgCost: 500, currency: "USD", broker: "manual", dateAcquired: "2024-01-02", marketValue: 10000, markPrice: 1000 };
    const ticker = makeTicker({ portfolios: ["main"], positions: [position] });
    const input = { shares: 100, avgCost: 50, currency: "USD" };
    const reconciled = setManualPortfolioPosition(ticker, "main", input).ticker.metadata.positions[0]!;
    expect(reconciled.dateAcquired).toBe("2024-01-02");
    expect(reconciled.shares * reconciled.avgCost).toBe(position.shares * position.avgCost);
    expect(reconciled.marketValue).toBeUndefined();
    expect(reconciled.markPrice).toBeUndefined();
    ticker.metadata.positions.push({ ...position, dateAcquired: "2024-03-01" });
    expect(setManualPortfolioPosition(ticker, "main", input).ticker.metadata.positions[0]!.dateAcquired).toBeUndefined();
  });

  test("resolves position currency from explicit, ticker, portfolio, or base currency defaults", () => {
    const portfolio = { id: "research", name: "Research", currency: "EUR" };

    expect(resolveManualPositionCurrency("jpy", makeTicker(), portfolio, "USD")).toBe("JPY");
    expect(resolveManualPositionCurrency("", makeTicker({ currency: "CAD" }), portfolio, "USD")).toBe("CAD");
    expect(resolveManualPositionCurrency("", makeTicker({ currency: "" }), portfolio, "USD")).toBe("EUR");
    expect(resolveManualPositionCurrency("", makeTicker({ currency: "" }), { ...portfolio, currency: "" }, "USD")).toBe("USD");
  });
});
