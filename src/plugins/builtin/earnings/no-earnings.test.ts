import { expect, test } from "bun:test";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestHeadlessContext } from "../../../test-support/headless";
import { createEarningsHeadless } from "./headless";
import { loadNoEarningsText, noEarningsText } from "./no-earnings";

test("a type that never reports earnings says so and offers a stock; a stock and an unknown type say nothing", () => {
  expect(noEarningsText("SPY", "ETF", "cli")).toBe("SPY is an ETF; ETFs have no earnings. Try `fn ERN AAPL`.");
  expect(noEarningsText("VFIAX", "MUTUALFUND", "cli")).toBe("VFIAX is a fund; funds have no earnings. Try `fn ERN AAPL`.");
  expect(noEarningsText("BTC-USD", "CRYPTOCURRENCY", "cli")).toBe("BTC-USD is a cryptocurrency; cryptocurrencies have no earnings. Try `fn ERN AAPL`.");
  expect(noEarningsText("EURUSD=X", "CURRENCY", "cli")).toBe("EURUSD=X is a currency pair; currency pairs have no earnings. Try `fn ERN AAPL`.");
  expect(noEarningsText("CL=F", "FUTURE", "cli")).toBe("CL=F is a future; futures have no earnings. Try `fn ERN AAPL`.");
  expect(noEarningsText("^GSPC", "INDEX", "cli")).toBe("^GSPC is an index; indexes have no earnings. Try `fn ERN AAPL`.");
  // A symbol's own syntax places it when no type came back.
  expect(noEarningsText("^GSPC", undefined, "cli")).toContain("is an index");
  expect(noEarningsText("NEWCO", "EQUITY", "cli")).toBeNull();
  expect(noEarningsText("NEWCO", undefined, "cli")).toBeNull();
});

test("the app's pane says the command a reader types there, with no CLI syntax or backticks", () => {
  expect(noEarningsText("SPY", "ETF", "pane")).toBe("SPY is an ETF; ETFs have no earnings. Try ERN AAPL.");
  expect(noEarningsText("CL=F", "FUTURE", "pane")).toBe("CL=F is a future; futures have no earnings. Try ERN AAPL.");
});

test("the type is read from the quote, and a quote that fails leaves a stock's empty history as it was", async () => {
  const quoting = (type: string | null) => createTestDataProvider({ getQuote: async (symbol) => createTestQuote({ symbol, instrumentType: type ?? undefined }) });
  expect(await loadNoEarningsText(quoting("ETF"), "SPY", "pane")).toBe("SPY is an ETF; ETFs have no earnings. Try ERN AAPL.");
  expect(await loadNoEarningsText(quoting("EQUITY"), "NEWCO", "pane")).toBeNull();
  const failing = createTestDataProvider({ getQuote: async () => { throw new Error("offline"); } });
  expect(await loadNoEarningsText(failing, "NEWCO", "pane")).toBeNull();
  expect(await loadNoEarningsText(failing, "^GSPC", "cli")).toContain("is an index");
});

test("ERN for an ETF answers that it has no earnings, with no error and nothing missing, where a stock with no reports stays empty", async () => {
  const ern = (type: string, history: () => Promise<never>) => createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history,
    upcoming: async () => [],
  }).load(
    { rawArgument: "X", argument: "X", symbols: ["X"], options: {} },
    createTestHeadlessContext({ marketData: createTestDataProvider({ getQuote: async (symbol) => createTestQuote({ symbol, instrumentType: type }) }) }),
  );
  // The history of a fund or a coin may fail as well as come back empty: either way the type answers.
  const fund = await ern("ETF", async () => ({ asOf: "2026-10-15T00:00:00.000Z", symbol: "X", name: null, reports: [] }) as never);
  expect(fund).toMatchObject({ rows: [], empty: "X is an ETF; ETFs have no earnings. Try `fn ERN AAPL`.", complete: true, unavailableSymbols: [] });
  const coin = await ern("CRYPTOCURRENCY", async () => { throw new Error("A US ticker symbol is required"); });
  expect(coin.errors).toBeUndefined();
  expect(coin.empty).toContain("is a cryptocurrency");
  const stock = await ern("EQUITY", async () => ({ asOf: "2026-10-15T00:00:00.000Z", symbol: "X", name: null, reports: [] }) as never);
  expect(stock.empty).toBeUndefined();
  expect(stock.complete).toBeUndefined();
});
