/**
 * Layouts the desktop shell measurements and the kernel profile load.
 *
 * - `default`: the layout a new install opens with.
 * - `heavy`: twelve panes, eight of them charts over years of daily data,
 *   the kind of layout where the window's JavaScript is busiest.
 * - `multi`: the default layout plus two popped-out panes, so a launch opens
 *   three windows.
 */

type Instance = {
  instanceId: string;
  paneId: string;
  binding: { kind: "none" } | { kind: "fixed"; symbol: string };
  settings?: Record<string, unknown>;
};
type DockNode =
  | { kind: "pane"; instanceId: string }
  | { kind: "split"; axis: "horizontal" | "vertical"; ratio: number; first: DockNode; second: DockNode };

export interface SpikeLayout {
  dockRoot: DockNode | null;
  instances: Instance[];
  floating: unknown[];
  detached: Array<{ instanceId: string; x: number; y: number; width: number; height: number }>;
}

function priceChart(symbol: string): Instance {
  const id = `${symbol.toLowerCase()}-market-ohlcv-1`;
  return {
    instanceId: `chart-composer:${symbol.toLowerCase()}`,
    paneId: "chart-composer",
    binding: { kind: "fixed", symbol },
    settings: {
      chartSpec: {
        version: 2,
        viewport: { range: "5Y", resolution: "auto" },
        panels: [{ id: "main" }, { id: "volume", label: "Volume", height: 0.24 }],
        series: [{
          id,
          source: { kind: "security", instrument: { symbol }, fieldId: "market.ohlcv", period: "auto" },
          transform: "raw",
          axis: "auto",
          panelId: "main",
          style: "candles",
          interpolation: "none",
        }],
        studies: [{
          id: `builtin:volume:${id}`,
          kind: "volume",
          inputSeriesIds: [id],
          parameters: {},
          panelId: "volume",
          axis: "auto",
        }],
      },
    },
  };
}

function comparisonChart(symbols: string[]): Instance {
  return {
    instanceId: "chart-composer:compare",
    paneId: "chart-composer",
    binding: { kind: "none" },
    settings: {
      chartSpec: {
        version: 2,
        viewport: { range: "5Y", resolution: "1d" },
        panels: [{ id: "main" }],
        series: symbols.map((symbol, index) => ({
          id: `${symbol.toLowerCase()}-market-close-${index + 1}`,
          source: { kind: "security", instrument: { symbol }, fieldId: "market.close", period: "auto" },
          transform: "percent",
          axis: "left",
          panelId: "main",
          style: "line",
          interpolation: "none",
        })),
        studies: [],
      },
    },
  };
}

/** A dock tree that splits `ids` in halves, alternating the axis. */
function balanced(ids: string[], axis: "horizontal" | "vertical" = "vertical"): DockNode {
  if (ids.length === 1) return { kind: "pane", instanceId: ids[0]! };
  const middle = Math.ceil(ids.length / 2);
  const next = axis === "vertical" ? "horizontal" : "vertical";
  return {
    kind: "split",
    axis,
    ratio: middle / ids.length,
    first: balanced(ids.slice(0, middle), next),
    second: balanced(ids.slice(middle), next),
  };
}

export function heavyLayout(): SpikeLayout {
  const instances: Instance[] = [
    ...["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "SPY"].map(priceChart),
    comparisonChart(["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"]),
    { instanceId: "market-valuation:heavy", paneId: "market-valuation", binding: { kind: "none" }, settings: { indicator: "buffett", range: "25Y" } },
    { instanceId: "econ-statistics:heavy", paneId: "econ-statistics", binding: { kind: "none" }, settings: { stat: "cpi-yoy", range: "20Y" } },
    { instanceId: "quote-monitor:heavy", paneId: "quote-monitor", binding: { kind: "none" }, settings: { symbols: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "SPY", "QQQ", "IWM"], symbolsText: "AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, SPY, QQQ, IWM" } },
    { instanceId: "market-heatmap:heavy", paneId: "market-heatmap", binding: { kind: "none" } },
    { instanceId: "news-top:heavy", paneId: "news-top", binding: { kind: "none" } },
  ];
  return {
    dockRoot: balanced(instances.map((instance) => instance.instanceId)),
    instances,
    floating: [],
    detached: [],
  };
}

/** The default layout's panes in the main window, and two more in windows of their own. */
export function multiWindowLayout(base: SpikeLayout, frames: Array<{ x: number; y: number; width: number; height: number }>): SpikeLayout {
  const extra: Instance[] = [priceChart("AAPL"), { instanceId: "news-top:detached", paneId: "news-top", binding: { kind: "none" } }];
  return {
    ...base,
    instances: [...base.instances, ...extra],
    detached: extra.map((instance, index) => ({ instanceId: instance.instanceId, ...frames[index % frames.length]! })),
  };
}
