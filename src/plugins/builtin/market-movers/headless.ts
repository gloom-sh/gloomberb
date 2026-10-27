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
import { loadMarketMoverTab, loadSessionMovers, marketMoverQuoteError, type MarketMoverTabResult } from "./client";
import { createRows, fiftyTwoWeekPositionPercent, formatMoverPrice, MOVER_RANKING_LABELS, moverExtendedSessions, moverReferencePrice, type MarketMoverRow, type ScreenerTabId, type TabId } from "./model";
import { EXTENDED_SESSION_LABELS, type ExtendedSession } from "../../../market-data/market/status";
import type { HeadlessPaneColumn } from "../../../types/headless";
import { isSessionTab, resolveSide } from "./session";
import { hasPartialFloat, minFloatShares, normalizeMinFloat, PARTIAL_FLOAT_NOTE } from "./min-float";

const rowPrice = (value: unknown, row: Record<string, unknown>) => formatMoverPrice(typeof value === "number" ? value : null, typeof row.currency === "string" ? row.currency : "", moverReferencePrice(row as unknown as MarketMoverRow));

const COLUMNS: HeadlessPaneColumn[] = [
  { key: "rank", header: "Rank", align: "right" as const },
  { key: "symbol", header: "Symbol" },
  { key: "name", header: "Name" },
  { key: "price", header: "Last", align: "right" as const, format: rowPrice },
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

/** The pre-market or after-hours print and its move from the regular close, for the rows that have one. */
function extendedColumn(session: ExtendedSession): HeadlessPaneColumn {
  return {
    key: "extendedPrice",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right",
    format: (value, row) => row.extendedSession === session && typeof value === "number"
      ? `${rowPrice(value, row)} ${percent(row.extendedChangePercent)}`
      : "—",
  };
}

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

const FLOAT_COLUMN: HeadlessPaneColumn = { key: "floatShares", header: "Float", align: "right", format: compact };

export interface MarketMoversHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    tab: ScreenerTabId,
    provider: DataProvider,
    minFloat: number | null,
  ): Promise<MarketMoverTabResult>;
  loadSession(
    view: CloudSessionMoversCategory,
    side: CloudSessionMoversSide,
    minFloat: number | null,
  ): Promise<CloudSessionMoversPayload>;
}

/**
 * Headless reads, including VIEW sources, wait for average volumes rather
 * than returning a partial first paint. Keep that wait bounded by the usual
 * market request timeout; interactive MOST retains its shorter cutoff.
 */
const ONE_SHOT_METADATA_WAIT_MS = 10_000;

const defaultDependencies: MarketMoversHeadlessDependencies = {
  load: (_args, tab, provider, minFloat) => loadMarketMoverTab(tab, provider, { metadataWaitMs: ONE_SHOT_METADATA_WAIT_MS, minFloat }),
  loadSession: (view, side, minFloat) => loadSessionMovers(view, side, { minFloat }),
};

export function createMarketMoversHeadless(
  dependencies: MarketMoversHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    // The delayed lists unless the list says it is real-time; rows keep the time of their own last price.
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
    }, {
      key: "min-float",
      description: "Keep the rows whose float (the one EQS serves) is at least this many shares, such as 10M or 500k; any lifts it. A row with no float is left out. Trending carries no float and ignores it.",
      type: "string",
      placeholder: "shares",
      example: "--min-float 10M",
      normalize: normalizeMinFloat,
      pluginState: { pluginId: "market-overview", key: "minFloat" },
    }],
    columns: COLUMNS,
    describe: (args) => isSessionTab(String(args.options.list))
      ? `Market Movers | ${String(args.options.list)} ${resolveSide(args.options.list as CloudSessionMoversCategory, String(args.options.side))}`
      : `Market Movers | ${String(args.options.list)}`,
    async load(args, ctx) {
      const tab = args.options.list as TabId;
      const minFloatValue = typeof args.options["min-float"] === "string" ? args.options["min-float"] : null;
      const minFloat = minFloatShares(minFloatValue);
      if (isSessionTab(tab)) {
        const side = resolveSide(tab, String(args.options.side));
        const payload = await dependencies.loadSession(tab, side, minFloat);
        return {
          columns: sessionColumns(tab),
          rows: payload.items.map((item) => ({
            ...item,
            events: item.catalysts.map((catalyst) => CATALYST_LABEL[catalyst] ?? catalyst).join(" "),
          })),
          ...(hasPartialFloat(payload.items) ? { notes: [PARTIAL_FLOAT_NOTE] } : {}),
          metadata: { list: tab, side, session: payload.session, phase: payload.phase, asOf: payload.asOf, stale: payload.stale === true, minFloat },
          // A Pro account's list is the live board; the free one says it is delayed.
          ...(payload.access === "delayed" ? {} : { freshness: { status: "live" as const } }),
        };
      }
      // Trending carries no float, so a minimum does not apply to it.
      const floatFiltered = minFloat != null && tab !== "trending";
      const result = await dependencies.load(args, tab, ctx.marketData, floatFiltered ? minFloat : null);
      const ranked = createRows(result.quotes);
      // Last and Change % are the regular session; an extended print is a column of its own.
      const extendedSessions = moverExtendedSessions(ranked);
      const rows = ranked.map(({ extended, ...row }) => ({
        ...row,
        extendedSession: extended?.session ?? null,
        extendedPrice: extended?.price ?? null,
        extendedChange: extended?.change ?? null,
        extendedChangePercent: extended?.changePercent ?? null,
        rangePositionPercent: fiftyTwoWeekPositionPercent(
          row.price,
          row.fiftyTwoWeekLow,
          row.fiftyTwoWeekHigh,
        ),
      }));
      // Beside an extended column, say which move the order follows.
      const rankedBy = result.rankedBy ?? null;
      const quoteError = marketMoverQuoteError(result);
      const columns = [...COLUMNS.slice(0, 5), ...extendedSessions.map(extendedColumn), ...COLUMNS.slice(5), ...(floatFiltered ? [FLOAT_COLUMN] : [])];
      const notes = [
        ...(rankedBy && rankedBy !== "volume" && extendedSessions.length > 0 ? [`Ranked by ${MOVER_RANKING_LABELS[rankedBy]}.`] : []),
        ...(minFloat != null && !floatFiltered ? ["Trending carries no float, so --min-float does not apply to it."] : []),
        ...(floatFiltered && hasPartialFloat(rows) ? [PARTIAL_FLOAT_NOTE] : []),
      ];
      return {
        ...(columns.length !== COLUMNS.length ? { columns } : {}),
        rows,
        ...(quoteError ? { complete: false, unavailableSymbols: result.unavailableSymbols, errors: [quoteError] } : {}),
        ...(notes.length > 0 ? { notes } : {}),
        metadata: { list: tab, source: result.source, stale: result.stale, rankedBy, minFloat: floatFiltered ? minFloat : null },
        // A Pro account's Gainers, Losers and Most Active are the real-time lists.
        ...(result.source === "cloud" ? { freshness: { status: "live" as const } } : {}),
      };
    },
  };
}

export const marketMoversHeadless = createMarketMoversHeadless();
