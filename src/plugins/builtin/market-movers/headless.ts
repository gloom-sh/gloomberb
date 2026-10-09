import type { DataProvider } from "../../../types/data-provider";
import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatCompact, formatNumber, formatPercentRaw } from "../../../utils/format";
import type {
  CloudSessionMoversCategory,
  CloudSessionMoversPayload,
  CloudSessionMoversSide,
} from "../../../api-client/market-movers";
import { loadMarketMoverTab, loadSessionMovers, type MarketMoverTabResult } from "./client";
import { createRows, fiftyTwoWeekPositionPercent, formatMoverPrice, moverReferencePrice, type MarketMoverRow, type ScreenerTabId, type TabId } from "./model";
import { isSessionTab, resolveSide } from "./session";

const COLUMNS = [
  { key: "rank", header: "Rank", align: "right" as const },
  { key: "symbol", header: "Symbol" },
  { key: "name", header: "Name" },
  { key: "price", header: "Last", align: "right" as const, format: (value: unknown, row: Record<string, unknown>) => formatMoverPrice(typeof value === "number" ? value : null, typeof row.currency === "string" ? row.currency : "", moverReferencePrice(row as unknown as MarketMoverRow)) },
  { key: "changePercent", header: "Change %", align: "right" as const, format: (value: unknown) => value == null ? "—" : formatPercentRaw(Number(value)) },
  { key: "volume", header: "Volume", align: "right" as const, format: (value: unknown) => value == null ? "—" : formatCompact(Number(value), { fixedDecimals: true }) },
  { key: "volumeRatio", header: "Vol / Avg", align: "right" as const, format: (value: unknown) => value == null ? "—" : formatNumber(Number(value), 1) },
  // A position within the range, not a change, so it carries no sign.
  { key: "rangePositionPercent", header: "52W pos", align: "right" as const, format: (value: unknown) => value == null ? "—" : `${Math.round(Number(value))}%` },
  { key: "marketCap", header: "Market cap", align: "right" as const, format: (value: unknown) => value == null ? "—" : formatCompact(Number(value), { fixedDecimals: true }) },
];

const percent = (value: unknown) => value == null ? "—" : formatPercentRaw(Number(value));
const ratio = (value: unknown) => value == null ? "—" : `${formatNumber(Number(value), 1)}x`;
const compact = (value: unknown) => value == null ? "—" : formatCompact(Number(value), { fixedDecimals: true });
const CATALYST_LABEL: Record<string, string> = { halt: "Halt", filing: "8-K", news: "News" };
const SESSION_VOLUME: Record<CloudSessionMoversCategory, string> = {
  premarket: "Pre-market volume",
  afterhours: "After-hours volume",
  gaps: "Volume",
};

function sessionColumns(view: CloudSessionMoversCategory) {
  return [
    { key: "rank", header: "Rank", align: "right" as const },
    { key: "symbol", header: "Symbol" },
    { key: "name", header: "Name" },
    { key: "price", header: "Last", align: "right" as const, format: (value: unknown, row: Record<string, unknown>) => formatMoverPrice(typeof value === "number" ? value : null, "USD", typeof row.referenceClose === "number" ? row.referenceClose : undefined) },
    ...(view === "gaps" ? [{ key: "gapPercent", header: "Gap %", align: "right" as const, format: percent }] : []),
    { key: "changePercent", header: "Change %", align: "right" as const, format: percent },
    { key: "volume", header: SESSION_VOLUME[view], align: "right" as const, format: compact },
    { key: "relativeVolume", header: "Rel volume", align: "right" as const, format: ratio },
    ...(view === "gaps" ? [{ key: "vwapPercent", header: "From VWAP %", align: "right" as const, format: percent }] : []),
    { key: "floatShares", header: "Float", align: "right" as const, format: compact },
    { key: "events", header: "Events" },
  ];
}

export interface MarketMoversHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    tab: ScreenerTabId,
    provider: DataProvider,
  ): Promise<MarketMoverTabResult>;
  loadSession(
    view: CloudSessionMoversCategory,
    side: CloudSessionMoversSide,
  ): Promise<CloudSessionMoversPayload>;
}

/**
 * Headless reads, including VIEW sources, wait for average volumes rather
 * than returning a partial first paint. Keep that wait bounded by the usual
 * market request timeout; interactive MOST retains its shorter cutoff.
 */
const ONE_SHOT_METADATA_WAIT_MS = 10_000;

const defaultDependencies: MarketMoversHeadlessDependencies = {
  load: (_args, tab, provider) => loadMarketMoverTab(tab, provider, { metadataWaitMs: ONE_SHOT_METADATA_WAIT_MS }),
  loadSession: (view, side) => loadSessionMovers(view, side),
};

export function createMarketMoversHeadless(
  dependencies: MarketMoversHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    // A screener snapshot, not a real-time feed; rows keep the time of their own last price.
    freshness: { status: "delayed" },
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
        { value: "premarket", aliases: ["pre-market", "pre"] },
        { value: "afterhours", aliases: ["after-hours", "ah", "post"] },
        { value: "gaps", aliases: ["gap"] },
      ],
      defaultValue: "actives",
      // Not `activeTab`: a requested list is kept whatever session is trading.
      pluginState: { pluginId: "market-overview", key: "requestedTab" },
    }, {
      key: "side",
      description: "Pre-market, after-hours and gap lists: up, down or active (gaps have no active list).",
      type: "enum",
      values: [
        { value: "up", aliases: ["gainers"] },
        { value: "down", aliases: ["losers"] },
        { value: "active" },
      ],
      defaultValue: "up",
      pluginState: { pluginId: "market-overview", key: "sessionSide" },
    }],
    columns: COLUMNS,
    describe: (args) => isSessionTab(String(args.options.list))
      ? `Market Movers | ${String(args.options.list)} ${resolveSide(args.options.list as CloudSessionMoversCategory, String(args.options.side))}`
      : `Market Movers | ${String(args.options.list)}`,
    async load(args, ctx) {
      const tab = args.options.list as TabId;
      if (isSessionTab(tab)) {
        const side = resolveSide(tab, String(args.options.side));
        const payload = await dependencies.loadSession(tab, side);
        return {
          columns: sessionColumns(tab),
          rows: payload.items.map((item) => ({
            ...item,
            events: item.catalysts.map((catalyst) => CATALYST_LABEL[catalyst] ?? catalyst).join(" "),
          })),
          metadata: { list: tab, side, session: payload.session, phase: payload.phase, asOf: payload.asOf, stale: payload.stale === true },
        };
      }
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
