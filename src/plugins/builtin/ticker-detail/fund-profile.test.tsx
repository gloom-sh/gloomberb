import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { fundFactsCache } from "../sec/fund-facts";
import { act } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import { createTestTicker } from "../../../test-support/ticker";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { buildTickerReport, ticker as runTickerCommand } from "../../../cli/commands/ticker";
import { createTestCliContext } from "../../../test-support/cli-context";
import type { TickerFinancials } from "../../../types/financials";
import { OverviewTab } from "./overview-tab";

const config = createDefaultConfig("/tmp/gloom-fund-profile-test-unused");
const ticker = createTestTicker("CLASSA", "Controlled accumulating fund", { assetCategory: "STK", exchange: "XETRA", currency: "EUR" });
const quote = { symbol: "CLASSA", instrumentType: "ETF", currency: "EUR", price: 100, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-09-11") };
const profile = { description: "Controlled accumulating share class follows a published index." };

function tickerCommandContext(financials: TickerFinancials) {
  return createTestCliContext({
    config, dataDir: "/tmp/gloom-fund-profile-test-unused", store: { loadTicker: async () => ticker },
    dataProvider: { ...createTestDataProvider({ getTickerFinancials: async () => financials }), getNews: async () => [] },
  });
}

const tui = createOpenTuiTestHarness();

for (const quoted of [true, false]) test(`fund classification and profile survive ${quoted ? "generic saved broker type" : "missing quote"} across consumers`, async () => {
  const financials: TickerFinancials = {
    ...(quoted ? { quote } : { quoteMetadata: { symbol: "CLASSA", instrumentType: "ETF", currency: "EUR", source: { stale: true, lastUpdated: quote.lastUpdated } } }),
    profile, fundamentals: { dividendYield: 0 }, priceHistory: [], annualStatements: [], quarterlyStatements: [],
  };
  await act(async () => {
    await tui.render(<AppContext value={createStaticAppStore(createInitialState(config))}>
      <OverviewTab ticker={ticker} financials={financials} width={80} />
    </AppContext>, { width: 80, height: 24 });
  });
  await settleFrame(tui.setup(), 10);
  const frame = tui.frame();
  expect(frame).toMatch(/Type\s+ETF/);
  expect(frame).toContain(profile.description);
  expect(frame).toMatch(/Div Yield\s+0.00%/);
  const text = await buildTickerReport({ symbol: "CLASSA", tickerFile: ticker, financials, config, toBase: async v => v });
  expect(text).toContain("Type ETF");
  expect(text).toContain(profile.description);
  expect(text).toContain("0.00%");
  const cli = tickerCommandContext(financials);
  await runTickerCommand("CLASSA", cli.context);
  expect(cli.closeCount()).toBe(1);
  const { data: captured, warnings } = cli.printed[0]!.result;
  expect(captured.profile).toEqual(profile);
  expect(captured.fundamentals.dividendYield).toBe(0);
  expect(captured.quote?.instrumentType ?? captured.quoteMetadata?.instrumentType).toBe("ETF");
  expect(ticker.metadata.assetCategory).toBe("STK");
  if (!quoted) {
    expect(captured.quote).toBeNull();
    expect(warnings).toEqual(["Quote unavailable."]);
    expect(text).toContain("Quote unavailable.");
    expect(text).not.toContain("Last:");
  }
});

for (const scenario of ["zero", "nonfinite", "empty", "legacy-return", "covered-return"] as const) test(`quote-free ticker report availability: ${scenario}`, async () => {
  const valid = scenario === "zero" || scenario === "covered-return";
  const financials: TickerFinancials = {
    fundamentals: scenario === "zero" ? { dividendYield: 0 }
      : scenario === "nonfinite" ? { dividendYield: Number.NaN }
        : scenario === "legacy-return" ? { return1Y: .05, return3Y: .05 } : undefined,
    annualStatements: [], quarterlyStatements: [],
    priceHistory: scenario === "covered-return" ? [{ date: new Date("2025-09-10"), close: 100 }, { date: new Date("2026-09-11"), close: 100 }] : [],
  };
  const cli = tickerCommandContext(financials);
  const command = runTickerCommand("CLASSA", cli.context);
  if (valid) {
    await command;
    const captured = cli.printed[0]!.result.data;
    expect(scenario === "zero" ? captured.fundamentals.dividendYield : captured.fundamentals.return1Y).toBe(0);
  } else { await expect(command).rejects.toThrow("No research data available"); expect(cli.printed).toHaveLength(0); }
  expect(cli.closeCount()).toBe(1);
});


test("blank source type cannot hide retained fund classification while reports skip blanks", async () => {
  const savedFund = createTestTicker("CLASSA", "Controlled fund", { assetCategory: "ETF" });
  for (const quoted of [true, false]) {
    const financials: TickerFinancials = {
      ...(quoted ? { quote: { ...quote, instrumentType: " " } } : {}),
      quoteMetadata: { symbol: "CLASSA", instrumentType: quoted ? "ETF" : " ", source: {} },
      profile, annualStatements: [], quarterlyStatements: [], priceHistory: [],
    };
    expect(await buildTickerReport({ symbol: "CLASSA", tickerFile: savedFund, financials, config, toBase: async v => v })).toContain("Type ETF");
    expect(financials.quote?.instrumentType).toBe(quoted ? " " : undefined);
    expect(financials.quoteMetadata?.instrumentType).toBe(quoted ? "ETF" : " ");
  }
});


test("quote-free reported capitalization retains source units, zero, and provenance without borrowing unknown units", async () => {
  for (const [marketCap, currency] of [[200_000_000, "GBP"], [0, "USD"], [200_000_000, undefined]] as const) {
    const financials: TickerFinancials = { annualStatements: [], quarterlyStatements: [], priceHistory: [],
      fundamentals: { marketCap, marketCapCurrency: currency, source: "gloom", fetchedAt: "2026-09-11T14:00:00Z", stale: true },
    };
    const text = await buildTickerReport({ symbol: "CLASSA", tickerFile: ticker, financials, config, toBase: async () => Number.NaN });
    if (currency) {
      expect(text).toContain(currency === "GBP" ? "200M GBP" : "0 USD");
      expect(text).toContain("gloom fundamentals");
      expect(text).toContain("stale; valuation date unavailable");
    } else expect(text).not.toContain("Market Cap");
    expect(text).toContain("Quote unavailable.");
    expect(financials.fundamentals?.marketCap).toBe(marketCap);
  }
});

test("a US-listed fund's overview shows its fund facts where a company's fundamentals would be; a fund listed elsewhere asks for none", async () => {
  fundFactsCache.reset();
  const etf = createTestTicker("IVV", "iShares Core S&P 500 ETF", { assetCategory: "ETF", exchange: "NYSE", currency: "USD" });
  const facts = spyOn(apiClient, "getFundFacts").mockImplementation(async () => ({
    ticker: "IVV", covered: true, name: "iShares Core S&P 500 ETF", structure: "registered",
    expenseRatio: { value: 0.03, asOf: "2026-10-16", source: "iShares", kind: "net" },
    nav: { value: 766.76, asOf: "2026-10-16", source: "iShares" },
    closingPrice: null, premiumDiscount: null,
    netAssets: { value: 712_340_000_000, asOf: "2026-10-16", source: "iShares", scope: "fund" },
    sponsor: { value: "BlackRock (iShares)", asOf: null, source: "iShares" },
    inception: { value: "2000-05-15", asOf: null, source: "iShares" },
    index: null, stale: false, fetchedAt: null,
  }));
  try {
    const financials: TickerFinancials = { quote: { ...quote, symbol: "IVV", currency: "USD" }, priceHistory: [], annualStatements: [], quarterlyStatements: [] };
    await act(async () => {
      await tui.render(<AppContext value={createStaticAppStore(createInitialState(config))}>
        <OverviewTab ticker={etf} financials={financials} width={100} />
      </AppContext>, { width: 100, height: 40 });
    });
    await settleFrame(tui.setup(), 10);
    const frame = tui.frame();
    expect(facts).toHaveBeenCalledWith("IVV");
    expect(frame).toContain("Fund Facts");
    expect(frame).toMatch(/NAV\s+\$766\.76\s+2026-10-16/);
    // Every figure is dated; a narrow column takes the date without its year.
    // iShares states the whole fund's net assets, which the label says.
    expect(frame).toMatch(/Fund Assets\s+\$712\.34B\s+(?:2026-)?10-16/);
    expect(frame).toMatch(/Exp Ratio\s+0\.03%\s+net (?:2026-)?10-16/);

    // Vanguard's month-end net assets read as month end; a stale NAV says so.
    fundFactsCache.reset();
    facts.mockImplementation(async () => ({
      ticker: "IVV", covered: true, name: "Vanguard S&P 500 ETF", structure: "registered",
      expenseRatio: { value: 0.03, asOf: "2026-04-28", source: "Vanguard", kind: "net" },
      nav: { value: 701.68, asOf: "2026-10-01", source: "Vanguard" },
      closingPrice: null, premiumDiscount: null,
      netAssets: { value: 1e12, asOf: "2026-09-30", source: "Vanguard", scope: "share-class", period: "month-end" },
      sponsor: null, inception: null, index: null, stale: true, fetchedAt: null,
    }));
    await act(async () => {
      await tui.render(<AppContext value={createStaticAppStore(createInitialState(config))}>
        <OverviewTab ticker={etf} financials={financials} width={160} />
      </AppContext>, { width: 160, height: 40 });
    });
    await settleFrame(tui.setup(), 10);
    expect(tui.frame()).toMatch(/NAV\s+\$701\.68\s+2026-10-01 stale/);
    expect(tui.frame()).toMatch(/Net Assets\s+\$1T\s+2026-09-30 month-end/);

    facts.mockClear();
    await act(async () => {
      await tui.render(<AppContext value={createStaticAppStore(createInitialState(config))}>
        <OverviewTab ticker={ticker} financials={{ quote, profile, priceHistory: [], annualStatements: [], quarterlyStatements: [] }} width={100} />
      </AppContext>, { width: 100, height: 40 });
    });
    await settleFrame(tui.setup(), 10);
    expect(facts).not.toHaveBeenCalled();
    expect(tui.frame()).not.toContain("Fund Facts");
  } finally {
    facts.mockRestore();
    fundFactsCache.reset();
  }
});
