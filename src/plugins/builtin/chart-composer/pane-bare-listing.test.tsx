import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { setSharedRegistryForTests } from "../../registry";
import type { ChartSpec } from "../../../time-series/types";
import { ChartComposerPane } from "./pane";
import { buildCustomChartPreset, buildPriceChartPreset } from "./presets";
import { useSeriesListings } from "./series-listings";

const tui = createOpenTuiTestHarness();

// 2222 is Kotobuki Spirits in Tokyo and Saudi Aramco in Riyadh; no source quotes the bare code. AAPL quotes as itself.
const QUOTES: Record<string, ReturnType<typeof createTestQuote>> = {
  "2222:JPX": createTestQuote({ symbol: "2222", name: "Kotobuki Spirits Co., Ltd.", currency: "JPY", listingExchangeName: "JPX" }),
  "2222:TADAWUL": createTestQuote({ symbol: "2222", name: "Saudi Arabian Oil Co.", currency: "SAR", listingExchangeName: "TADAWUL" }),
  AAPL: createTestQuote({ symbol: "AAPL", name: "Apple Inc.", currency: "USD", listingExchangeName: "NASDAQ" }),
  // Nothing quotes the bare root NDX; the service marks ^NDX:NIM for it.
  "^NDX:NIM": createTestQuote({ symbol: "^NDX:NIM", name: "NASDAQ-100", currency: "USD", instrumentType: "INDEX", listingExchangeName: "NASDAQ GIDS" }),
};
const VENUES: Record<string, Array<[string, string]>> = {
  "2222": [["JPX", "Kotobuki Spirits Co., Ltd."], ["TADAWUL", "Saudi Arabian Oil Co."]],
  AAPL: [["NASDAQ", "Apple Inc."]],
};
const INDEXES: Record<string, Array<[string, string]>> = { NDX: [["^NDX", "NASDAQ-100"]] };
const BARS = Array.from({ length: 5 }, (_, day) => ({
  date: new Date(Date.UTC(2026, 9, 5 + day)), open: 30, high: 30, low: 30, close: 30, volume: 1_000,
}));

function quoteOf(symbol: string, exchange = "") {
  const key = parsePublicTickerKey(symbol);
  const venue = key.exchange || exchange;
  const quote = QUOTES[venue && key.symbol !== "AAPL" ? `${key.symbol}:${venue}` : key.symbol];
  if (!quote && (key.symbol === "NDX" || key.symbol === "DFII10")) throw new Error(`Not a ticker: ${key.symbol}.`);
  if (!quote) throw new Error(`No quote provider available for ${symbol}`);
  return quote;
}

/** `charted` takes the listings whose financials the chart asks for, `bars` those whose bars it asks for. */
function provider(charted: string[], bars: string[] = []) {
  return createTestDataProvider({
    search: async (query) => [
      ...(VENUES[query.trim().toUpperCase()] ?? []).map(([exchange, name]) => ({
        providerId: "test", symbol: query.trim().toUpperCase(), name, exchange, type: "Common Stock", currency: "USD",
      })),
      ...(INDEXES[query.trim().replace(/^\^/, "").toUpperCase()] ?? []).map(([symbol, name]) => ({
        providerId: "test", symbol, name, exchange: "NIM", type: "INDEX", searchAliases: [symbol.slice(1)],
      })),
    ],
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
    getPriceHistory: async (symbol, exchange) => {
      bars.push(exchange ? `${symbol}:${exchange}` : symbol);
      return BARS;
    },
    getPriceHistoryWithMetadata: async (symbol, exchange) => {
      bars.push(exchange ? `${symbol}:${exchange}` : symbol);
      return { resolution: "1d", points: BARS };
    },
    getPriceHistoryForResolution: async (symbol, exchange) => {
      bars.push(exchange ? `${symbol}:${exchange}` : symbol);
      return BARS;
    },
  });
}

async function renderChart(symbol: string, charted: string[], bars: string[] = []) {
  const dataProvider = provider(charted, bars);
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

test("the chart pane charts a bare index root as the index quote reads it as, symbol and venue both", async () => {
  const bars: string[] = [];
  await renderChart("NDX", [], bars);
  const frame = await frameWith("^NDX:NIM Price");
  // NDX is read as ^NDX on NIM: never a line NDX:NIM no venue has, nor the bare code a source may still serve.
  expect(bars.length, frame).toBeGreaterThan(0);
  expect(bars.every((key) => key === "^NDX:NIM")).toBe(true);
});

/** What the pane loads for a spec: each series' source and label, once no bare one is still being read. */
function ListingsProbe({ spec }: { spec: ChartSpec }) {
  const listings = useSeriesListings(spec);
  return <text>{listings.pending ? "reading" : listings.spec.series.map((entry) => `[${entry.source.kind} ${entry.label ?? "-"}]`).join(" ")}</text>;
}

test("the chart pane reads a bare FRED id no ticker answers to as that series, and labels FRED series by the catalog's short name, as fn G does", async () => {
  // `G DFII10` failed "Not a ticker: DFII10." in the pane while `fn G DFII10` charted the TIPS yield; AAPL stays the ticker.
  const spec = buildCustomChartPreset("DFII10, AAPL, FRED:DFII10");
  const names: Record<string, string> = { "FRED:DFII10": "10Y TIPS real yield" };
  setSharedRegistryForTests({ series: { findByExpression: (expression: string) => names[expression] ? { definition: { name: names[expression] } } : undefined, list: () => [] } } as never);
  try {
    const dataProvider = provider([]);
    const state = createInitialState(createTestPaneConfig("/tmp/gloom-chart-bare-listing-unused", { instanceId: "probe", paneId: "chart-composer" }));
    await tui.render(
      <TestPaneProvider state={state} paneId="probe" pluginId="charts" runtime={createTestPluginRuntime({ getMarketData: () => dataProvider })}>
        <ListingsProbe spec={spec} />
      </TestPaneProvider>,
      { width: 160, height: 4 },
    );
    expect(await frameWith("[economic 10Y TIPS real yield] [security -] [economic 10Y TIPS real yield]")).toBeTruthy();
  } finally {
    setSharedRegistryForTests(undefined);
  }
});
