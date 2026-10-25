import { expect, setSystemTime, test } from "bun:test";
import type { HeadlessPaneContext } from "../../../types/headless";
import { createDefaultConfig } from "../../../types/config";
import { createTestTicker } from "../../../test-support/ticker";
import { portfolioRiskHeadless } from "./risk-headless";
import { BROKER_PORTFOLIO, brokerFixtureHoldings, brokerFixtureTickers, brokerRiskClient, now, sessionHistory } from "./risk-test-data";

test("local evidence reports keep account identity and work without market network access", async () => {
  const portfolio = { id: "local", name: "Local account", currency: "USD" };
  const evidence = { version: 1, portfolioId: portfolio.id, currency: "USD", source: "Illustrative ledger", performance: {
    flowTiming: "end-of-day", externalFlowsComplete: true, observations: [
      { date: "2025-01-02", value: 100, externalFlow: 0 }, { date: "2026-01-02", value: 125, externalFlow: 0 },
    ],
  } };
  const requested: string[] = [];
  const context = { config: { ...createDefaultConfig("/tmp/unused-risk-headless"), portfolios: [portfolio] }, signal: new AbortController().signal,
    apiClient: new Proxy({}, { get() { throw new Error("Unexpected market network access"); } }),
    resolvePortfolio: async (id: string) => { requested.push(id); return id === portfolio.id ? { portfolio, tickers: [] } : null; },
  } as unknown as HeadlessPaneContext;
  const args = { rawArgument: "local", argument: "local", symbols: [], options: { view: "performance", evidence: JSON.stringify(evidence) } };
  const result = await portfolioRiskHeadless.load(args, context);
  expect(requested).toEqual(["local"]); expect(result.complete).toBe(true);
  const rows = (result.metadata as { model: { rows: Record<string, Array<{ id: string; value: number | null }>> } }).model.rows.performance!;
  expect(rows.find(row => row.id === "twr")!.value).toBe(25);
  expect(rows.find(row => row.id === "mwr")!.value).toBeCloseTo(25, 8);
  expect(result.sections.find(row => row.title === "performance")!.rows![0]).toMatchObject({ value: expect.stringMatching(/%$/) });
  // The error names the portfolios and ids that exist, so a guessed id ("default") is fixed in one more call.
  await expect(portfolioRiskHeadless.load({ ...args, rawArgument: "default" }, context)).rejects.toThrow("Unknown local portfolio: default. Portfolios: Local account (local).");
  await expect(portfolioRiskHeadless.load({ ...args, options: { ...args.options, evidence: JSON.stringify({ ...evidence, currency: "EUR" }) } }, context)).rejects.toThrow("different portfolio or currency");
});

test("a portfolio with no holdings answers with the commands that fill it, not a table of dashes, and asks the market for nothing", async () => {
  const portfolio = { id: "main", name: "Main Portfolio", currency: "USD" };
  const listed = (symbols: string[]) => symbols.map((symbol) => createTestTicker(symbol, symbol, { portfolios: [portfolio.id], positions: [] }));
  const load = (tickers: ReturnType<typeof listed>) => portfolioRiskHeadless.load(
    { rawArgument: "", argument: null, symbols: [], options: {} },
    { config: { ...createDefaultConfig("/tmp/unused-risk-headless"), portfolios: [portfolio] }, signal: new AbortController().signal,
      apiClient: new Proxy({}, { get() { throw new Error("Unexpected market network access"); } }),
      resolvePortfolio: async () => ({ portfolio, tickers }),
    } as unknown as HeadlessPaneContext,
  );
  const empty = await load([]);
  expect(empty.sections).toEqual([]);
  // `portfolio add` lists a symbol, `position set` gives it shares; risk reads shares.
  expect(empty.empty).toBe("No holdings in Main Portfolio. Add symbols with gloom portfolio add 'Main Portfolio' AAPL,MSFT, "
    + "then their shares with gloom portfolio position set 'Main Portfolio' AAPL 10 150.");
  expect(empty.metadata).toEqual({ portfolio: { id: "main", name: "Main Portfolio", currency: "USD" } });
  // Symbols listed without shares are named, and so is the command that gives one its shares.
  expect((await load(listed(["AAPL", "MSFT"]))).empty)
    .toBe("Main Portfolio lists AAPL, MSFT but holds no shares: gloom portfolio position set 'Main Portfolio' AAPL 10 150.");
});

function riskRow(id: string, value: number | null, unit = "% gross") {
  return { id, label: id, value, unit, percentile: null, asOf: "2026-10-01T00:00:00.000Z", detail: `${id} evidence` };
}

test("the compact result is the requested view, without the model, with the strongest pairs", () => {
  const holdings = Array.from({ length: 120 }, (_, index) => ({ id: `NASDAQ:H${index}`, symbol: `H${index}`, value: 1_000 - index }));
  const pairs = holdings.flatMap((left, index) => holdings.slice(index + 1).map((right, offset) => (
    riskRow(`${left.id}/${right.id}`, ((index * 7 + offset) % 199) / 100 - 0.99, "correlation")
  )));
  pairs[42] = { ...pairs[42]!, value: -0.995 };
  const model = {
    portfolio: { id: "broker:test:U1", name: "Broker account", currency: "USD" },
    holdings,
    fetchedAt: "2026-10-01T12:00:00.000Z",
    complete: true,
    coverage: { currency: "USD", marketValue: 100_000, coveredValue: 100_000, share: 1, holdings: 120, covered: 120, unvalued: 0, minimumShare: 0.5, sufficient: true, leftOut: [] },
    rows: {
      risk: [riskRow("vol", 12.5, "%")],
      factors: [],
      holdings: holdings.map((holding) => riskRow(holding.symbol, holding.value / 1_000)),
      correlation: pairs,
      // A shock that moves every holding: a line each, then the book's total.
      stress: [...holdings.map((holding) => riskRow(`shock:${holding.id}`, -20, "%")), riskRow("shock:book", -20, "%")],
      performance: [],
      attribution: [],
      greeks: [],
    },
  };
  const full = {
    complete: true,
    errors: ["Treasury yield: Internal server error"],
    sections: Object.entries(model.rows).map(([title, rows]) => ({ title, rows })),
    metadata: { model },
  };
  const args = (view: string) => ({ rawArgument: "", argument: null, symbols: [], options: { view } });

  const correlation = portfolioRiskHeadless.compact!(full as never, args("correlation"));
  expect(correlation.sections.map((section) => section.title)).toEqual(["correlation"]);
  expect(correlation.metadata?.model).toBeUndefined();
  expect(correlation.metadata).toMatchObject({ view: "correlation", coverage: { share: 1, holdings: 120, leftOut: [] }, portfolio: { id: "broker:test:U1" } });
  const strongest = correlation.sections[0]!.rows!;
  expect(strongest).toHaveLength(25);
  expect(strongest[0]!.label).toBe(pairs[42]!.label);
  expect(correlation.metadata?.notices).toEqual([`Strongest 25 of ${pairs.length} pairs by absolute correlation.`]);
  expect(correlation.errors).toEqual(full.errors);

  const book = portfolioRiskHeadless.compact!(full as never, args("holdings"));
  expect(book.sections[0]!.rows).toHaveLength(100);
  expect(book.metadata?.notices).toEqual(["20 more holdings rows not shown."]);
  // The cap takes lines, never what they total.
  const stress = portfolioRiskHeadless.compact!(full as never, args("stress")).sections[0]!.rows!;
  expect([stress.length, stress.at(-1)!.label, stress.at(-2)!.label]).toEqual([100, "shock:book", "shock:NASDAQ:H98"]);

  // The report keeps every view and the model.
  expect(full.sections).toHaveLength(8);
  expect(full.metadata.model).toBe(model);
});

test("the report and its compact form state what the basket covers and why each holding is left out", async () => {
  setSystemTime(now);
  try {
    const tickers = brokerFixtureTickers();
    // The account's cash is in lira, by the broker's own balances: 1,000,000 TRY at 0.0202 is $20,200.
    const account = { accountId: "U1", name: "Broker account", cashBalances: [{ currency: "TRY", quantity: 1_000_000 }] };
    const context = {
      config: { ...createDefaultConfig("/unused/risk-headless"), portfolios: [BROKER_PORTFOLIO] },
      signal: new AbortController().signal,
      apiClient: brokerRiskClient(now),
      resolvePortfolio: async () => ({ portfolio: BROKER_PORTFOLIO, tickers, account }),
    } as unknown as HeadlessPaneContext;
    const args = { rawArgument: BROKER_PORTFOLIO.id, argument: BROKER_PORTFOLIO.id, symbols: [], options: { view: "risk" } };
    const full = await portfolioRiskHeadless.load(args, context);
    expect(full.complete).toBe(false);
    expect(full.metadata?.coverage).toMatchObject({ holdings: 94, covered: 85, estimated: true, shareIsUpperBound: false, marketValue: 488_760, cashValue: 20_200 });
    // What the estimate leaves out is a note; the report itself did not fail.
    expect(full.errors).toEqual([]);
    expect(full.notes).toContain("TWD1 (3.8% of the book) is excluded from the risk estimate: foreign holdings: daily FX closes unavailable.");
    expect(full.notes?.[0]).toBe("TRY cash (4.1% of the book) is excluded from the risk estimate: cash is outside the equity basket; its USD value moves with TRY.");
    // Every risk row is a number, not a dash.
    expect(full.sections.find((section) => section.title === "risk")!.rows!.every((row) => row.value !== "--")).toBe(true);
    // The tail losses in money name their method and what the basket they are taken on is of the book; the other rows do not.
    const riskRows = full.sections.find((section) => section.title === "risk")!.rows!;
    const line = "basket 365,500 USD = 75% of book; left out: TRY cash 4%, EUR2 4%, 8 more 17%";
    expect(riskRows.filter((row) => String(row.detail).includes("of book")).map((row) => [row.label, row.detail])).toEqual([
      ["1D VaR 95% (60D)", `historical, 1-day, 95%, 60 daily returns; ${line}`],
      ["1D expected shortfall (60D)", `historical, 1-day, 95%, 60 daily returns; ${line}`],
    ]);

    const compact = portfolioRiskHeadless.compact!(full, args);
    expect(compact.notes).toEqual([`B${line.slice(1)}; metadata.coverage lists each with its reason.`]);
    expect(compact.errors).toBeUndefined();
    const coverage = compact.metadata?.coverage as { share: number; leftOut: Array<{ symbol: string; reason: string; share: number; cash?: true }> };
    expect(coverage.share).toBeCloseTo(365_500 / 488_760, 10);
    expect(coverage.leftOut[0]).toMatchObject({ symbol: "TRY cash", cash: true });
    expect(coverage.leftOut[1]).toMatchObject({ symbol: "EUR2", reason: "Foreign holdings: daily FX closes unavailable" });
    expect(coverage.leftOut[1]!.share).toBeCloseTo(20_020 / 488_760, 10);
    expect(coverage.leftOut.at(-1)).toMatchObject({ symbol: "UNQ3", reason: "Daily history unavailable" });

    // With nothing but crypto the basket views have no estimate: a failure the report states, beside the note naming the holding.
    const crypto = brokerFixtureTickers([{ symbol: "ETH-USD", exchange: "CCC", currency: "USD", quantity: 2, price: 2_500, brokerValue: 5_000 }]);
    const cryptoOnly = await portfolioRiskHeadless.load(args, { ...context, resolvePortfolio: async () => ({ portfolio: BROKER_PORTFOLIO, tickers: crypto }) } as unknown as HeadlessPaneContext);
    expect(cryptoOnly.errors).toEqual([expect.stringContaining("Basket estimates unavailable: No holding qualifies")]);
    expect(cryptoOnly.notes).toEqual(["ETH-USD (100.0% of the book) is excluded from the risk estimate: crypto is not covered by the equity basket."]);
  } finally {
    setSystemTime();
  }
});

test("--since filed buys the 13F's weights at the filing-date close and holds them; --weights current holds today's", async () => {
  setSystemTime(now);
  try {
    // Three holdings, today worth 100, 200 and 300 at $100, imported at 13F weights of 50%, 30% and 20%.
    const holdings = brokerFixtureHoldings().filter((row) => ["US01", "US02", "US03"].includes(row.symbol));
    const withCost = (costs: Record<string, number | undefined>) => brokerFixtureTickers(holdings).map((ticker) => ({
      metadata: { ...ticker.metadata, positions: ticker.metadata.positions.map((lot) => ({ ...lot, avgCost: costs[ticker.metadata.ticker] })) },
    }));
    const source = { kind: "13f" as const, cik: "0001067983", name: "Fund", period: "2026-06-30", filed: "2026-08-14" };
    const weights = { US01: 0.5, US02: 0.3, US03: 0.2 };
    const context = (portfolio: typeof BROKER_PORTFOLIO, tickers = brokerFixtureTickers(holdings)) => ({
      config: { ...createDefaultConfig("/unused/risk-headless"), portfolios: [portfolio] },
      signal: new AbortController().signal,
      apiClient: brokerRiskClient(now, holdings),
      resolvePortfolio: async () => ({ portfolio, tickers }),
    } as unknown as HeadlessPaneContext);
    const args = (options: Record<string, string> = {}) => ({ rawArgument: BROKER_PORTFOLIO.id, argument: BROKER_PORTFOLIO.id, symbols: [], options: { view: "risk", since: "filed", ...options } });
    const value = (result: Awaited<ReturnType<typeof portfolioRiskHeadless.load>>, id: string) =>
      (result.metadata as { model: { rows: { risk: Array<{ id: string; value: number | null }> } } }).model.rows.risk.find((row) => row.id === id)!.value;

    // Independently, from each holding's closes: a copier's basket is worth sum(w * end / start).
    const closes = (symbol: string) => new Map(sessionHistory(symbol, "NASDAQ").data!.map((row) => [row.date.slice(0, 10), row.close]));
    const series = Object.keys(weights).map((symbol) => closes(symbol));
    const end = [...series[0]!.keys()].at(-1)!;
    const held = Object.values(weights).reduce((sum, weight, index) => sum + weight * series[index]!.get(end)! / series[index]!.get("2026-08-14")!, 0);

    const imported = { ...BROKER_PORTFOLIO, importedFrom: { ...source, weights } };
    const since = await portfolioRiskHeadless.load(args(), context(imported));
    expect(since.sections[0]!.rows!.map((row) => row.label)).toContain("Basket return since 2026-08-14");
    expect(value(since, "return")).toBeCloseTo((held - 1) * 100, 10);
    // Sessions from the 14 August close to the last completed one, 21 September.
    expect(since.metadata).toMatchObject({ benchmark: "SPY", window: { kind: "since-filed", filed: "2026-08-14", start: "2026-08-14", sessions: 25, weights: "13f", weightsSource: "stored" } });
    expect(since.metadata?.notices).toEqual(["Buy-and-hold from the 14 Aug 2026 close at the 13F's weights, against SPY"]);

    // Today's weights (1:2:3 by value) held fixed every session is another basket, and says so.
    const dates = [...series[0]!.keys()].filter((date) => date >= "2026-08-14");
    const fixed = dates.slice(1).reduce((wealth, date, index) => wealth * (1 + [1, 2, 3].reduce((sum, weight, holding) =>
      sum + weight / 6 * (series[holding]!.get(date)! / series[holding]!.get(dates[index]!)! - 1), 0)), 1);
    const current = await portfolioRiskHeadless.load(args({ weights: "current" }), context(imported));
    expect(Math.abs(fixed - held)).toBeGreaterThan(1e-4);
    expect(value(current, "return")).toBeCloseTo((fixed - 1) * 100, 10);
    expect(current.metadata?.notices).toEqual(["Current weights held fixed since the 14 Aug 2026 close, against SPY; not buy-and-hold"]);

    // Imported before weights were stored: shares times the 13F's cost rebuilds them (1 x 5, 2 x 1.5, 3 x 2/3).
    const legacy = { ...BROKER_PORTFOLIO, importedFrom: source };
    const rebuilt = await portfolioRiskHeadless.load(args(), context(legacy, withCost({ US01: 5, US02: 1.5, US03: 2 / 3 })));
    expect(value(rebuilt, "return")).toBeCloseTo((held - 1) * 100, 10);
    expect(rebuilt.notes).toContain("13F weights rebuilt from each position's shares and cost, as imported; this portfolio predates stored 13F weights.");
    // Without a cost to rebuild from, the rows are today's weights and the report says why.
    const uncosted = await portfolioRiskHeadless.load(args(), context(legacy, withCost({ US01: 5, US02: 1.5 })));
    expect(value(uncosted, "return")).toBeCloseTo((fixed - 1) * 100, 10);
    expect(uncosted.metadata?.notices).toEqual(["Current weights held fixed since the 14 Aug 2026 close, against SPY; not buy-and-hold"]);
    expect(uncosted.notes).toContain(`"Broker account" has no stored 13F weights and US03 has no USD cost to rebuild them from, so the rows hold today's weights fixed. Re-import it (portfolio import --13f 0001067983 --replace) for buy-and-hold.`);

    // US03's closes end on 17 September (a halt): the rows stop there and say which holding stopped them.
    const halted = context(imported);
    const client = halted.apiClient as unknown as ReturnType<typeof brokerRiskClient>;
    const history = client.getCloudHistory;
    client.getCloudHistory = async (symbol: string, exchange: string) => {
      const answer = await history(symbol, exchange);
      return symbol === "US03" && answer.data ? { ...answer, data: answer.data.filter((row) => row.date.slice(0, 10) <= "2026-09-17") } : answer;
    };
    const cut = await portfolioRiskHeadless.load(args(), halted);
    const through = (date: string) => Object.values(weights).reduce((sum, weight, index) => sum + weight * series[index]!.get(date)! / series[index]!.get("2026-08-14")!, 0);
    expect(value(cut, "return")).toBeCloseTo((through("2026-09-17") - 1) * 100, 10);
    expect(cut.notes).toContain("The buy-and-hold rows end on 2026-09-17: US03 has no daily close after it.");

    const fallback = await portfolioRiskHeadless.load(args(), context(BROKER_PORTFOLIO));
    expect(fallback.sections[0]!.rows!.map((row) => row.label)).toContain("60D benchmark return (SPY)");
    expect(fallback.metadata?.notices).toEqual([`"Broker account" was not imported from a 13F, so it has no filing date; the risk rows cover the trailing 60 sessions.`]);
    expect(fallback.notes?.some((note) => note.includes("not imported from a 13F"))).toBe(false);
  } finally {
    setSystemTime();
  }
});
