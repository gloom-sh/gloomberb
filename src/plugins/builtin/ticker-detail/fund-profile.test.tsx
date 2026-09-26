import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender, settleFrame } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { createTestTicker } from "../../../test-support/ticker";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { buildTickerReport, ticker as runTickerCommand } from "../../../cli/commands/ticker";
import type { MarketContext } from "../../../cli/types";
import type { TickerFinancials } from "../../../types/financials";
import { OverviewTab } from "./overview-tab";

const config = createDefaultConfig("/tmp/gloom-fund-profile-test-unused");
const ticker = createTestTicker("CLASSA", "Controlled accumulating fund", { assetCategory: "STK", exchange: "XETRA", currency: "EUR" });
const quote = { symbol: "CLASSA", instrumentType: "ETF", currency: "EUR", price: 100, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-09-11") };
const profile = { description: "Controlled accumulating share class follows a published index." };
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
});

for (const quoted of [true, false]) test(`fund classification and profile survive ${quoted ? "generic saved broker type" : "missing quote"} across consumers`, async () => {
  const financials: TickerFinancials = {
    ...(quoted ? { quote } : { quoteMetadata: { symbol: "CLASSA", instrumentType: "ETF", currency: "EUR", source: { stale: true, lastUpdated: quote.lastUpdated } } }),
    profile, fundamentals: { dividendYield: 0 }, priceHistory: [], annualStatements: [], quarterlyStatements: [],
  };
  await act(async () => {
    setup = await testRender(<AppContext value={{ state: createInitialState(config), dispatch: () => {} }}>
      <OverviewTab ticker={ticker} financials={financials} width={80} />
    </AppContext>, { width: 80, height: 24 });
  });
  await settleFrame(setup!, 10);
  const frame = setup!.captureCharFrame();
  expect(frame).toMatch(/Type:\s*ETF/);
  expect(frame).toContain(profile.description);
  expect(frame).toMatch(/Div Yield\s+0.00%/);
  const text = await buildTickerReport({ symbol: "CLASSA", tickerFile: ticker, financials, config, toBase: async v => v });
  expect(text).toContain("Type ETF");
  expect(text).toContain(profile.description);
  expect(text).toContain("0.00%");
  let captured: any;
  let warnings: string[] | undefined;
  let closed = 0;
  await runTickerCommand("CLASSA", {
    initMarketData: async () => ({
      config, dataDir: "/tmp/gloom-fund-profile-test-unused", store: { loadTicker: async () => ticker }, persistence: { close: () => { closed++; } },
      dataProvider: { ...createTestDataProvider({ getTickerFinancials: async () => financials }), getNews: async () => [] },
    }) as unknown as MarketContext,
    fail: message => { throw new Error(message); }, printResult: result => { captured = result.data; warnings = result.warnings; },
  });
  expect(closed).toBe(1);
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
  let captured: any;
  let closed = 0;
  const command = runTickerCommand("CLASSA", {
    initMarketData: async () => ({
      config, dataDir: "/tmp/gloom-fund-profile-test-unused", store: { loadTicker: async () => ticker }, persistence: { close: () => { closed++; } },
      dataProvider: { ...createTestDataProvider({ getTickerFinancials: async () => financials }), getNews: async () => [] },
    }) as unknown as MarketContext,
    fail: message => { throw new Error(message); }, printResult: result => { captured = result.data; },
  });
  if (valid) { await command; expect(scenario === "zero" ? captured.fundamentals.dividendYield : captured.fundamentals.return1Y).toBe(0); }
  else { await expect(command).rejects.toThrow("No research data available"); expect(captured).toBeUndefined(); }
  expect(closed).toBe(1);
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
      fundamentals: { marketCap, marketCapCurrency: currency, source: "yahoo", fetchedAt: "2026-09-11T14:00:00Z", stale: true },
    };
    const text = await buildTickerReport({ symbol: "CLASSA", tickerFile: ticker, financials, config, toBase: async () => Number.NaN });
    if (currency) {
      expect(text).toContain(currency === "GBP" ? "200M GBP" : "0 USD");
      expect(text).toContain("yahoo fundamentals");
      expect(text).toContain("stale; valuation date unavailable");
    } else expect(text).not.toContain("Market Cap");
    expect(text).toContain("Quote unavailable.");
    expect(financials.fundamentals?.marketCap).toBe(marketCap);
  }
});
