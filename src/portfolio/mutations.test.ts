import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../types/config";
import type { TickerPosition, TickerRecord } from "../types/ticker";
import {
  adoptFirstPositionCurrency,
  createManualPortfolio,
  deleteManualPortfolio,
  deleteWatchlist,
  hasOpenPortfolioPositions,
  LotCostFxMergeError,
  removeTickerFromPortfolio,
  resolveManualPositionCurrency,
  setManualPortfolioPosition,
  type SetManualPortfolioPositionInput,
} from "./mutations";
import { createTestTicker } from "../test-support/ticker";

const makeTicker = (overrides: Partial<TickerRecord["metadata"]> = {}) => createTestTicker("AAPL", "Apple Inc.", overrides);

describe("portfolio-list mutations", () => {
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

  test("deleting a watchlist takes its id off every ticker, and leaves other lists, portfolios and team lists alone", () => {
    const config = createDefaultConfig("/tmp/gloomberb-mutations");
    config.watchlists = [{ id: "watchlist", name: "Watchlist" }, { id: "tech", name: "Tech" }];
    const position = { portfolio: "main", shares: 3, avgCost: 200, currency: "USD", broker: "manual" };
    const held = makeTicker({ ticker: "AAPL", portfolios: ["main"], watchlists: ["tech", "watchlist"], positions: [position] });
    const shared = makeTicker({ ticker: "MSFT", watchlists: ["tech", "team:t1:w1"] });
    const untouched = makeTicker({ ticker: "NVDA", watchlists: ["watchlist"] });

    const result = deleteWatchlist(config, [held, shared, untouched], "tech");

    expect(result.config.watchlists.map((watchlist) => watchlist.id)).toEqual(["watchlist"]);
    expect(result.tickers).toEqual([
      makeTicker({ ticker: "AAPL", portfolios: ["main"], watchlists: ["watchlist"], positions: [position] }),
      makeTicker({ ticker: "MSFT", watchlists: ["team:t1:w1"] }),
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

  test("a manual position is signed: a short is a negative count, zero is refused, and a future keeps its contract size", () => {
    const ticker = makeTicker({ portfolios: ["main"], positions: [] });
    const short = setManualPortfolioPosition(ticker, "main", { shares: -1000, avgCost: 4216.30, currency: "USD", multiplier: 100 }).ticker;
    expect(short.metadata.positions).toEqual([{ portfolio: "main", shares: -1000, avgCost: 4216.30, currency: "USD", broker: "manual", multiplier: 100 }]);
    expect(() => setManualPortfolioPosition(ticker, "main", { shares: 0, avgCost: 1, currency: "USD" })).toThrow("Shares cannot be 0. Enter a negative number for a short.");
    expect(() => setManualPortfolioPosition(ticker, "main", { shares: Number.NaN, avgCost: 1, currency: "USD" })).toThrow("Shares must be a number.");
    // A new count without terms to read keeps the contract size the lot had.
    expect(setManualPortfolioPosition(short, "main", { shares: -500, avgCost: 4200, currency: "USD" }).ticker.metadata.positions[0]).toMatchObject({ shares: -500, multiplier: 100 });
    // A future counts contracts, and its refusal says so.
    const gold = { ...ticker, metadata: { ...ticker.metadata, ticker: "GC=F", assetCategory: "FUTURE" } };
    expect(() => setManualPortfolioPosition(gold, "main", { shares: 0, avgCost: 1, currency: "USD" })).toThrow("Contracts cannot be 0. Enter a negative number for a short.");
  });

  test("split reconciliation preserves a single acquisition date without retaining stale valuation", () => {
    const position = { portfolio: "main", shares: 10, avgCost: 500, currency: "USD", broker: "manual", dateAcquired: "2024-01-02", marketValue: 10000, markPrice: 1000 };
    const ticker = makeTicker({ portfolios: ["main"], positions: [position] });
    const input = { shares: 100, avgCost: 50, currency: "USD" };
    const reconciled = setManualPortfolioPosition(ticker, "main", input).ticker.metadata.positions[0]!;
    expect(reconciled.dateAcquired).toBe("2024-01-02");
    expect(reconciled.shares * reconciled.avgCost!).toBe(position.shares * position.avgCost);
    expect(reconciled.marketValue).toBeUndefined();
    expect(reconciled.markPrice).toBeUndefined();
  });

  test("several lots set as one keep their earliest purchase date and their FX rates weighted by cost, or refuse rates one position cannot keep", () => {
    const lot = (shares: number, avgCost: number, extra: Partial<TickerPosition> = {}): TickerPosition =>
      ({ portfolio: "main", shares, avgCost, currency: "USD", broker: "manual", ...extra });
    const set = (lots: TickerPosition[], input: Partial<SetManualPortfolioPositionInput> = {}) =>
      setManualPortfolioPosition(makeTicker({ portfolios: ["main"], positions: lots }), "main", { shares: 30, avgCost: 400, currency: "USD", ...input })
        .ticker.metadata.positions[0]!;
    // 10 × 410 at 31 TRY and 20 × 395 at 34 TRY: (4,100 × 31 + 7,900 × 34) / 12,000 TRY per USD, so the cost converts as the lots' did.
    const merged = set([
      lot(10, 410, { dateAcquired: "2024-03-01", costFxRate: 31, costFxCurrency: "TRY" }),
      lot(20, 395, { dateAcquired: "2023-11-15", costFxRate: 34, costFxCurrency: "TRY" }),
    ]);
    expect(merged).toMatchObject({ dateAcquired: "2023-11-15", costFxCurrency: "TRY" });
    expect(merged.costFxRate! * 12_000).toBeCloseTo(4_100 * 31 + 7_900 * 34, 6);
    // A lot without a date leaves the earliest known one; lots with no rate stay without one.
    expect(set([lot(10, 410), lot(20, 395, { dateAcquired: "2024-03-01" })])).toMatchObject({ dateAcquired: "2024-03-01" });
    expect(set([lot(10, 410), lot(20, 395)]).costFxRate).toBeUndefined();

    // One lot at the rate it was bought at and one at today's have no one rate: refused, not guessed or dropped.
    const mixed = [lot(10, 410, { costFxRate: 31, costFxCurrency: "TRY" }), lot(20, 395)];
    expect(() => set(mixed)).toThrow(LotCostFxMergeError);
    expect(() => set(mixed)).toThrow("Of the 2 lots, 1 converts its cost at the FX rate it was bought at and 1 at today's, so one position cannot keep their rates.");
    expect(() => set([lot(10, 410, { costFxRate: 31, costFxCurrency: "TRY" }), lot(5, 1, { costFxRate: 0.9, costFxCurrency: "EUR" })]))
      .toThrow("converted into different currencies");
    // The position's own rate, a cleared one, or a cost in another currency set it.
    expect(set(mixed, { costFx: { rate: 32, currency: "TRY" } }).costFxRate).toBe(32);
    expect(set(mixed, { costFx: null }).costFxRate).toBeUndefined();
    expect(set(mixed, { currency: "TRY", avgCost: 13_000 }).costFxRate).toBeUndefined();
  });

  test("the rate a cost was bought at stays with the lot while its currency does, and goes when the currency changes", () => {
    const position = { portfolio: "main", shares: 10, avgCost: 410, currency: "USD", broker: "manual", dateAcquired: "2024-03-01", costFxRate: 31.37, costFxCurrency: "TRY" };
    const ticker = makeTicker({ portfolios: ["main"], positions: [position] });
    const kept = setManualPortfolioPosition(ticker, "main", { shares: 12, avgCost: 400, currency: "usd" }).ticker.metadata.positions[0]!;
    expect(kept).toMatchObject({ dateAcquired: "2024-03-01", costFxRate: 31.37, costFxCurrency: "TRY" });
    // Entered in the portfolio's currency, the cost needs no rate.
    const lira = setManualPortfolioPosition(ticker, "main", { shares: 10, avgCost: 20310, currency: "TRY" }).ticker.metadata.positions[0]!;
    expect(lira.costFxRate).toBeUndefined();
    expect(setManualPortfolioPosition(ticker, "main", { shares: 10, avgCost: 410, currency: "USD", costFx: null }).ticker.metadata.positions[0]!.costFxRate).toBeUndefined();
    expect(setManualPortfolioPosition(ticker, "main", { shares: 10, avgCost: 410, currency: "USD", costFx: { rate: 32.15, currency: "try" } }).ticker.metadata.positions[0])
      .toMatchObject({ costFxRate: 32.15, costFxCurrency: "TRY" });
  });

  test("resolves position currency from explicit, ticker, portfolio, or base currency defaults", () => {
    const portfolio = { id: "research", name: "Research", currency: "EUR" };

    expect(resolveManualPositionCurrency("jpy", makeTicker(), portfolio, "USD")).toBe("JPY");
    expect(resolveManualPositionCurrency("", makeTicker({ currency: "CAD" }), portfolio, "USD")).toBe("CAD");
    expect(resolveManualPositionCurrency("", makeTicker({ currency: "" }), portfolio, "USD")).toBe("EUR");
    expect(resolveManualPositionCurrency("", makeTicker({ currency: "" }), { ...portfolio, currency: "" }, "USD")).toBe("USD");
    // A corn future's cost is typed as corn is quoted, in US cents, unless a currency is typed.
    expect(resolveManualPositionCurrency("", makeTicker({ currency: "USD" }), portfolio, "USD", "USX")).toBe("USX");
    expect(resolveManualPositionCurrency("usd", makeTicker({ currency: "" }), portfolio, "USD", "USX")).toBe("USD");
  });

  test("the first position in an empty manual portfolio sets its currency, with the default USD base only", () => {
    const config = createDefaultConfig("/tmp/gloomberb-mutations");
    config.portfolios.push(
      { id: "asx", name: "ASX", currency: "USD" },
      { id: "team", name: "Team", currency: "USD", teamId: "t1" },
      { id: "broker:ibkr", name: "IBKR", currency: "USD", brokerId: "ibkr", brokerInstanceId: "ibkr-live" },
    );
    const bhp = makeTicker({ ticker: "BHP", currency: "AUD", portfolios: ["asx"], positions: [
      { portfolio: "asx", shares: 100, avgCost: 40, currency: "AUD", broker: "manual" },
    ] });
    expect(hasOpenPortfolioPositions("asx", [bhp])).toBe(true);
    expect(hasOpenPortfolioPositions("asx", [makeTicker({ portfolios: ["asx"] })])).toBe(false);

    expect(adoptFirstPositionCurrency(config, "asx", "AUD")?.portfolios.find((entry) => entry.id === "asx")?.currency).toBe("AUD");
    // Refilled with a USD holding, an emptied AUD portfolio goes back to USD.
    const audConfig = adoptFirstPositionCurrency(config, "asx", "AUD")!;
    expect(adoptFirstPositionCurrency(audConfig, "asx", "USD")?.portfolios.find((entry) => entry.id === "asx")?.currency).toBe("USD");
    expect(adoptFirstPositionCurrency(config, "asx", "USD")).toBeNull();
    // Pence, US cents and free text never become a portfolio currency; team and broker portfolios keep theirs.
    expect(adoptFirstPositionCurrency(config, "asx", "GBX")).toBeNull();
    expect(adoptFirstPositionCurrency(config, "asx", "USX")).toBeNull();
    expect(adoptFirstPositionCurrency(config, "asx", "Aussie")).toBeNull();
    expect(adoptFirstPositionCurrency(config, "team", "AUD")).toBeNull();
    expect(adoptFirstPositionCurrency(config, "broker:ibkr", "AUD")).toBeNull();
    // A base currency the user chose is what manual portfolios total in.
    expect(adoptFirstPositionCurrency({ ...config, baseCurrency: "EUR" }, "asx", "AUD")).toBeNull();
  });
});
