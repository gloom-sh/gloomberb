/** @jsxImportSource react */
/** Real table panes over invented, fixed observations, with no network. */
import { useLayoutEffect } from "react";
import { apiClient } from "../../src/api-client";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../src/market-data/coordinator";
import { SeasonalityPane } from "../../src/plugins/builtin/seasonality/pane";
import { HistoricalPricesPane } from "../../src/plugins/builtin/ticker-detail/data-panes/historical-prices";
import { VolatilityPane } from "../../src/plugins/builtin/volatility/pane";
import { PluginRenderProvider } from "../../src/plugins/runtime";
import { useAppDispatch } from "../../src/state/app/context";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../src/test-support/data-provider";
import { createTestPluginRuntime } from "../../src/test-support/plugin-runtime";
import { createTestTicker } from "../../src/test-support/ticker";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../src/theme/font-scale";
import type { LayoutConfig, PaneInstanceConfig } from "../../src/types/config";
import type { PricePoint } from "../../src/types/financials";
import type { PaneProps } from "../../src/types/plugin";

const SYMBOL = "ALFA";
const DAYS = Array.from({ length: 300 }, (_, index) => new Date(Date.UTC(2025, 11, 1 + index)))
  .filter((date) => date.getUTCDay() !== 0 && date.getUTCDay() !== 6);

function daily(symbol = SYMBOL): PricePoint[] {
  const seed = [...symbol].reduce((value, char) => value + char.charCodeAt(0), 0);
  return DAYS.map((date, index) => {
    const close = 12 + seed % 110 + Math.sin(index / 11) * 3 + index / 100;
    return { date, open: close - 0.4, high: close + 0.8, low: close - 1, close, volume: 500_000 + index * 3901 };
  });
}

const MONTHLY = Array.from({ length: 120 }, (_, index) => ({
  date: new Date(Date.UTC(2016, index, 1)),
  close: 80 * Math.exp(index / 300 + Math.sin(index / 4) / 10),
}));
const provider = createTestDataProvider({
  getPriceHistory: async (symbol) => daily(symbol),
  getPriceHistoryForResolutionWithMetadata: async (symbol, _exchange, _range, resolution) => ({
    points: resolution === "1mo" ? MONTHLY : daily(symbol), resolution, sourceName: "Gloom Cloud", sourceKey: "gloom",
  }),
  getQuote: async (symbol) => createTestQuote({ symbol, price: 100, lastUpdated: Date.UTC(2026, 8, 25, 20) }),
  getTickerFinancials: async () => createTestFinancials(),
});
const runtime = createTestPluginRuntime({ getMarketData: () => provider });

function VolatilityFixture(props: PaneProps) {
  return <PluginRenderProvider pluginId="volatility" runtime={runtime}><VolatilityPane {...props} /></PluginRenderProvider>;
}
function HistoryFixture(props: PaneProps) {
  return <PluginRenderProvider pluginId="ticker-research" runtime={runtime}><HistoricalPricesPane {...props} /></PluginRenderProvider>;
}
function SeasonalityFixture(props: PaneProps) {
  return <PluginRenderProvider pluginId="seasonality" runtime={runtime}><SeasonalityPane {...props} /></PluginRenderProvider>;
}

export const TABLE_RESIZE_PANES = {
  vols: { name: "VOLS", component: VolatilityFixture },
  hp: { name: "HP ALFA", component: HistoryFixture },
  seas: { name: "SEAS ALFA", component: SeasonalityFixture },
};

export function installTableResizeData(): void {
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
  apiClient.getCloudFredSeries = async (seriesId) => ({
    info: null,
    observations: daily(seriesId).map((point) => ({ date: point.date.toISOString().slice(0, 10), value: point.close! })),
  });
  apiClient.impliedVolatility = async <T,>() => ({
    series: ["COR1M", "COR3M"].map((id) => ({ id, source: "Cboe", observations:
      daily(id).map((point) => ({ date: point.date.toISOString().slice(0, 10), value: point.close! })) })),
  }) as T;
}

/** Supply the fixed binding through the same app state the panes normally read. */
export function TableResizeData() {
  const dispatch = useAppDispatch();
  useLayoutEffect(() => {
    dispatch({ type: "UPDATE_TICKER", ticker: createTestTicker(SYMBOL, "Alfa Instruments") });
  }, [dispatch]);
  return null;
}

export function tableResizeLayout(params: URLSearchParams): LayoutConfig {
  const kind = params.get("pane") ?? "vols";
  if (!(kind in TABLE_RESIZE_PANES) && kind !== "table") throw new Error(`Unknown table resize pane: ${kind}`);
  const instanceId = `${kind}:resize`;
  const current: PaneInstanceConfig = {
    instanceId, paneId: kind,
    binding: kind === "vols" ? { kind: "none" } : { kind: "fixed", symbol: SYMBOL },
    settings: kind === "vols" ? { initialTab: "board" } : {},
  };
  const plain: PaneInstanceConfig = { instanceId: "plain:back", paneId: "plain", binding: { kind: "none" } };
  if (params.get("mode") === "dock") return {
    dockRoot: { kind: "split", axis: "horizontal", ratio: 0.75,
      first: { kind: "pane", instanceId }, second: { kind: "pane", instanceId: plain.instanceId } },
    instances: [current, plain], floating: [], detached: [],
  };
  return {
    dockRoot: { kind: "pane", instanceId: plain.instanceId }, instances: [current, plain],
    floating: [{ instanceId, x: 2, y: 2, width: Math.min(window.innerWidth - 40, Number(params.get("fw")) || Infinity) / WEB_CELL_WIDTH,
      height: (window.innerHeight - 80) / WEB_CELL_HEIGHT, zIndex: 60 }], detached: [],
  };
}
