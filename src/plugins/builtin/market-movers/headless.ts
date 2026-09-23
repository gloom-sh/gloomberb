import type { DataProvider } from "../../../types/data-provider";
import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatCompact, formatNumber, formatPercentRaw } from "../../../utils/format";
import { loadMarketMoverTab, type MarketMoverTabResult } from "./client";
import { createRows, fiftyTwoWeekPositionPercent, formatMoverPrice, type TabId } from "./model";

const COLUMNS = [
  { key: "rank", header: "Rank", align: "right" as const },
  { key: "symbol", header: "Symbol" },
  { key: "name", header: "Name" },
  { key: "price", header: "Last", align: "right" as const, format: (value: unknown, row: Record<string, unknown>) => formatMoverPrice(typeof value === "number" ? value : null, typeof row.currency === "string" ? row.currency : "") },
  { key: "changePercent", header: "Change %", align: "right" as const, format: (value: unknown) => value == null ? "—" : formatPercentRaw(Number(value)) },
  { key: "volume", header: "Volume", align: "right" as const, format: (value: unknown) => value == null ? "—" : formatCompact(Number(value), { fixedDecimals: true }) },
  { key: "volumeRatio", header: "Vol / Avg", align: "right" as const, format: (value: unknown) => value == null ? "—" : formatNumber(Number(value), 1) },
  // A position within the range, not a change, so it carries no sign.
  { key: "rangePositionPercent", header: "52W pos", align: "right" as const, format: (value: unknown) => value == null ? "—" : `${Math.round(Number(value))}%` },
  { key: "marketCap", header: "Market cap", align: "right" as const, format: (value: unknown) => value == null ? "—" : formatCompact(Number(value), { fixedDecimals: true }) },
];

export interface MarketMoversHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    tab: TabId,
    provider: DataProvider,
  ): Promise<MarketMoverTabResult>;
}

const defaultDependencies: MarketMoversHeadlessDependencies = {
  load: (_args, tab, provider) => loadMarketMoverTab(tab, provider),
};

export function createMarketMoversHeadless(
  dependencies: MarketMoversHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: { kind: "none" },
    options: [{
      key: "list",
      description: "Market movers list.",
      type: "enum",
      values: [
        { value: "gainers" },
        { value: "losers" },
        { value: "actives", aliases: ["active", "most-active"] },
        { value: "trending" },
      ],
      defaultValue: "actives",
      pluginState: { pluginId: "market-overview", key: "activeTab" },
    }],
    columns: COLUMNS,
    describe: (args) => `Market Movers | ${String(args.options.list)}`,
    async load(args, ctx) {
      const tab = args.options.list as TabId;
      const result = await dependencies.load(args, tab, ctx.marketData);
      const rows = createRows(result.quotes).map((row) => ({
        ...row,
        rangePositionPercent: fiftyTwoWeekPositionPercent(
          row.price,
          row.fiftyTwoWeekLow,
          row.fiftyTwoWeekHigh,
        ),
      }));
      return {
        rows,
        metadata: { list: tab, source: result.source, stale: result.stale },
      };
    },
  };
}

export const marketMoversHeadless = createMarketMoversHeadless();
