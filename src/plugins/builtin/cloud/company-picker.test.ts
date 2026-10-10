import { describe, expect, test } from "bun:test";
import { FIRST_RUN_WATCHLIST } from "../../../components/onboarding/first-run-workspace";
import { DEFAULT_WATCHLIST_TICKERS } from "../../../state/app/bootstrap";
import type { TickerRecord } from "../../../types/ticker";
import { isNewAccount, needsCompanyPicks, planCompanyPicks } from "./company-picker";
import { STARTER_SYMBOLS } from "./starter-symbols";

function ticker(symbol: string, lists: { watchlists?: string[]; portfolios?: string[] } = {}): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      name: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      portfolios: lists.portfolios ?? [],
      watchlists: lists.watchlists ?? [],
      positions: [],
      custom: {},
      tags: [],
    },
  } as unknown as TickerRecord;
}

const seededWeb = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "TSLA"].map((symbol) => ticker(symbol, { watchlists: ["watchlist"] }));

describe("company picker", () => {
  test("knows every ticker the app seeds, and only those", () => {
    expect([...STARTER_SYMBOLS].sort()).toEqual(
      [...new Set([...DEFAULT_WATCHLIST_TICKERS, ...FIRST_RUN_WATCHLIST].map((entry) => entry.ticker))].sort(),
    );
  });

  test("asks only while the lists are still the seeded ones", () => {
    expect(needsCompanyPicks([], "watchlist")).toBe(true);
    expect(needsCompanyPicks(seededWeb, "watchlist")).toBe(true);
    // A company of their own, a trimmed list, or anything in a portfolio: already theirs.
    expect(needsCompanyPicks([...seededWeb, ticker("SNOW", { watchlists: ["watchlist"] })], "watchlist")).toBe(false);
    expect(needsCompanyPicks(seededWeb.slice(0, 3), "watchlist")).toBe(false);
    expect(needsCompanyPicks([...seededWeb, ticker("VICR", { portfolios: ["main"] })], "watchlist")).toBe(false);
  });

  test("turns the seeded list into the picks, keeping the person's other tickers", () => {
    const tickers = new Map([...seededWeb, ticker("AMD")].map((entry) => [entry.metadata.ticker, entry]));
    const plan = planCompanyPicks(tickers, "watchlist", [
      { symbol: "NVDA", name: "NVIDIA" },
      { symbol: "AMD", name: "AMD" },
      { symbol: "PLTR", name: "Palantir", seed: { ticker: "PLTR", name: "Palantir Technologies Inc.", exchange: "NASDAQ", currency: "USD", assetCategory: "STK" } },
    ]);

    expect(plan.create.map((entry) => [entry.ticker, entry.exchange, entry.watchlists])).toEqual([["PLTR", "NASDAQ", ["watchlist"]]]);
    const joined = plan.update.filter((entry) => entry.metadata.watchlists.includes("watchlist")).map((entry) => entry.metadata.ticker);
    const left = plan.update.filter((entry) => !entry.metadata.watchlists.includes("watchlist")).map((entry) => entry.metadata.ticker);
    expect(joined).toEqual(["AMD"]);
    // NVDA was picked, so it stays; the other seeded names come off.
    expect(left.sort()).toEqual(["AAPL", "AMZN", "MSFT", "QQQ", "SPY", "TSLA"]);
  });

  test("only asks accounts created in the last day", () => {
    const now = Date.parse("2026-10-01T12:00:00.000Z");
    expect(isNewAccount({ createdAt: "2026-10-01T09:00:00.000Z" }, now)).toBe(true);
    expect(isNewAccount({ createdAt: "2026-09-29T09:00:00.000Z" }, now)).toBe(false);
    expect(isNewAccount(null, now)).toBe(false);
  });
});
