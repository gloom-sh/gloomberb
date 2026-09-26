import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender, settleFrame } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import { createTestTicker } from "../../test-support/ticker";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { HeadlessPaneContext } from "../../types/headless";
import type { Quote, TickerFinancials } from "../../types/financials";
import { OverviewTab } from "../../plugins/builtin/ticker-detail/overview-tab";
import { quoteComparisonHeadless } from "../../plugins/builtin/ticker-detail/headless";
import { renderHeadlessPaneText } from "../pane-functions/headless";
import { buildTickerReport } from "./ticker";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
});

for (const [symbol, price, change, priorPrice] of [
  ["NG=F", 3.125, 0.001, 3.124],
  ["RB=F", 2.1234, 0.0001, 2.1233],
  ["6E=F", 1.17485, 0.00005, 1.1748],
  ["6J=F", 0.0062825, 0.0000005, 0.006282],
] as const) {
  test(`${symbol}: a quoted tick survives Overview, bid/ask, CLI and headless formatting`, async () => {
    const quote: Quote = {
      symbol, price, change, changePercent: change / priorPrice * 100,
      bid: priorPrice, ask: price, low: priorPrice, high: price,
      currency: "USD", instrumentType: "FUTURE", lastUpdated: Date.now(),
    };
    const config = createDefaultConfig("/tmp/gloom-futures-precision-unused");
    const financials: TickerFinancials = { quote, priceHistory: [], annualStatements: [], quarterlyStatements: [] };
    const priceText = `$${price}`;
    const priorText = `$${priorPrice}`;
    const changeText = `+$${change.toFixed(7).replace(/0+$/, "")}`;
    // A saved category must not override the current source's FUTURE type.
    const ticker = createTestTicker(symbol, symbol, { assetCategory: "STK", currency: "USD" });
    await act(async () => {
      setup = await testRender(
        <AppContext value={{ state: createInitialState(config), dispatch: () => {} }}>
          <OverviewTab ticker={ticker} financials={financials} width={120} />
        </AppContext>,
        { width: 120, height: 20 },
      );
    });
    await settleFrame(setup!, 8);
    const frame = setup!.captureCharFrame();
    expect(frame).toContain(priceText);
    expect(frame).toContain(priorText);
    const report = await buildTickerReport({ symbol, tickerFile: ticker, financials, config, toBase: async value => value });
    expect(report).toContain(priceText);
    expect(report).toContain(priorText);
    expect(report).toContain(changeText);

    const args = { symbols: [symbol], argument: [symbol], rawArgument: symbol, options: {} };
    const context = { marketData: createTestDataProvider({ getQuote: async () => quote }), signal: new AbortController().signal } as HeadlessPaneContext;
    const result = await quoteComparisonHeadless.load(args, context);
    expect(result.rows[0]).toMatchObject({ price, change, currency: "USD", instrumentType: "FUTURE" });
    const headless = renderHeadlessPaneText(quoteComparisonHeadless, result, args, "Quote Monitor");
    expect(headless).toContain(priceText);
    expect(headless).toContain(changeText);
  });
}
