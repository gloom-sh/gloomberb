import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { ChartComposerPane } from "./pane";
import { buildPriceChartPreset } from "./presets";

const tui = createOpenTuiTestHarness();

// 2222 is Kotobuki Spirits in Tokyo and Saudi Aramco in Riyadh; no source quotes the bare code. AAPL quotes as itself.
const QUOTES: Record<string, ReturnType<typeof createTestQuote>> = {
  "2222:JPX": createTestQuote({ symbol: "2222", name: "Kotobuki Spirits Co., Ltd.", currency: "JPY", listingExchangeName: "JPX" }),
  "2222:TADAWUL": createTestQuote({ symbol: "2222", name: "Saudi Arabian Oil Co.", currency: "SAR", listingExchangeName: "TADAWUL" }),
  AAPL: createTestQuote({ symbol: "AAPL", name: "Apple Inc.", currency: "USD", listingExchangeName: "NASDAQ" }),
};
const VENUES: Record<string, Array<[string, string]>> = {
  "2222": [["JPX", "Kotobuki Spirits Co., Ltd."], ["TADAWUL", "Saudi Arabian Oil Co."]],
  AAPL: [["NASDAQ", "Apple Inc."]],
};
const BARS = Array.from({ length: 5 }, (_, day) => ({
  date: new Date(Date.UTC(2026, 9, 5 + day)), open: 30, high: 30, low: 30, close: 30, volume: 1_000,
}));

function quoteOf(symbol: string, exchange = "") {
  const key = parsePublicTickerKey(symbol);
  const venue = key.exchange || exchange;
  const quote = QUOTES[venue && key.symbol !== "AAPL" ? `${key.symbol}:${venue}` : key.symbol];
  if (!quote) throw new Error(`No quote provider available for ${symbol}`);
  return quote;
}

function provider(charted: string[]) {
  return createTestDataProvider({
    search: async (query) => (VENUES[query.trim().toUpperCase()] ?? []).map(([exchange, name]) => ({
      providerId: "test", symbol: query.trim().toUpperCase(), name, exchange, type: "Common Stock", currency: "USD",
    })),
    getQuote: async (symbol, exchange) => quoteOf(symbol, exchange),
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]) => targets.map((target) => {
      try {
        return { target, quote: quoteOf(target.symbol, target.exchange) };
      } catch (error) {
        return { target, quote: null, error: (error as Error).message };
      }
    }),
    // A source that picks one line answers the bare code too: the chart must not ask it.
    getTickerFinancials: async (symbol, exchange) => {
      charted.push(exchange ? `${symbol}:${exchange}` : symbol);
      let quote = null;
      try { quote = quoteOf(symbol, exchange); } catch { /* history without a quote */ }
      return createTestFinancials({ quote: quote ?? undefined, priceHistory: BARS });
    },
    getPriceHistory: async () => BARS,
    getPriceHistoryWithMetadata: async () => ({ resolution: "1d", points: BARS }),
    getPriceHistoryForResolution: async () => BARS,
  });
}

async function renderChart(symbol: string, charted: string[]) {
  const dataProvider = provider(charted);
  const paneId = `bare-listing-${symbol}`;
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-chart-bare-listing-unused", {
    instanceId: paneId, paneId: "chart-composer", settings: { chartSpec: buildPriceChartPreset(symbol) },
  }));
  const runtime = createTestPluginRuntime({ getMarketData: () => dataProvider });
  await tui.render(
    <TestPaneProvider state={state} paneId={paneId} pluginId="charts" runtime={runtime}>
      <ChartComposerPane paneId={paneId} paneType="chart-composer" focused width={120} height={24} />
    </TestPaneProvider>,
    { width: 120, height: 24 },
  );
}

async function frameWith(text: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await act(async () => { await Bun.sleep(2); await tui.setup().renderOnce(); });
    if (tui.frame().includes(text)) return tui.frame();
  }
  throw new Error(`The chart never showed "${text}":\n${tui.frame()}`);
}

test("the chart pane asks which listing of a bare code several companies list, as quote does, and charts none of them", async () => {
  const charted: string[] = [];
  await renderChart("2222", charted);
  const frame = await frameWith("Choose an exchange for 2222.");
  expect(frame).not.toContain("Loading chart data");
  // The listings it asks between, under the question.
  expect(frame).toContain("2222:JPX Kotobuki Spirits · 2222:TADAWUL Saudi Arabian Oil");
  expect(charted).toEqual([]);
});

test("the chart pane names the company of a bare symbol it charts", async () => {
  const charted: string[] = [];
  await renderChart("AAPL", charted);
  await frameWith("Price · Apple");
  expect(charted.every((key) => key === "AAPL")).toBe(true);
});
