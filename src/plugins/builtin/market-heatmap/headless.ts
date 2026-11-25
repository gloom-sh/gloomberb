import type { HeadlessFreshnessStatus } from "../../../types/headless";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { formatCompact, formatPercentRaw } from "../../../utils/format";
import { MARKET_HEATMAP_REQUEST_COUNT, MARKET_HEATMAP_UNIVERSES, fetchMarketHeatmap, type MarketHeatmapBoard, type MarketHeatmapUniverseId } from "./data";
import { heatmapDelayedPrintTime, heatmapDelayedQuote, heatmapMove, summarizeHeatmapGroups, type HeatmapGroupBy, type HeatmapGroupSummary } from "./model";

/**
 * A few names always lack a move (foreign listings and new tickers the snapshot
 * has no change for). They are listed in a notice and in `metadata.noMove`; the
 * report is incomplete only when so many lack one that the groups mislead.
 */
const MIN_MOVE_COVERAGE = 0.9;

const percent = (value: unknown) => typeof value === "number" ? formatPercentRaw(value) : "—";
const share = (value: unknown) => typeof value === "number" ? `${value.toFixed(1)}%` : "—";
const dollars = (value: unknown) => typeof value === "number" && value > 0 ? `$${formatCompact(value)}` : "—";
const member = (symbol: unknown, move: unknown) => typeof symbol === "string" && typeof move === "number"
  ? `${symbol} ${formatPercentRaw(move)}`
  : "—";

function columns(universe: MarketHeatmapUniverseId, groupBy: HeatmapGroupBy, flat: boolean): HeadlessPaneColumn[] {
  return [
    ...(flat ? [] : groupBy === "industry"
      ? [{ key: "group", header: "Industry" }, { key: "sector", header: "Sector" }]
      : [{ key: "group", header: "Sector" }]),
    { key: "names", header: "Names", align: "right" },
    { key: "size", header: universe === "us-etf" ? "Net assets" : "Mkt cap", align: "right", format: dollars },
    ...(flat ? [] : [{ key: "sharePercent", header: "Cap share", align: "right" as const, format: share }]),
    { key: "move", header: universe === "us-etf" ? "Move (asset-wtd)" : "Move (cap-wtd)", align: "right", format: percent },
    { key: "up", header: "Up", align: "right" },
    { key: "down", header: "Down", align: "right" },
    { key: "bestSymbol", header: "Best", format: (value, row) => member(value, row.bestMove) },
    { key: "worstSymbol", header: "Worst", format: (value, row) => member(value, row.worstMove) },
  ];
}

function noMoveNotice(symbols: readonly string[], names: number): string {
  const shown = symbols.slice(0, 8).join(", ");
  const rest = symbols.length > 8 ? ` and ${symbols.length - 8} more` : "";
  return `${symbols.length} of ${names} names have no move yet and count toward size only: ${shown}${rest}.`;
}

/** A real-time board's names the server could not price live, as the report lists them. */
interface DelayedName {
  symbol: string;
  move: number | null;
  price: number | null;
  printedAt: string | null;
}

function delayedNames(assets: MarketHeatmapBoard["assets"]): DelayedName[] {
  return assets.flatMap((asset) => {
    const delayed = heatmapDelayedQuote(asset);
    if (!delayed) return [];
    const printedAt = typeof delayed.printedAt === "number" && delayed.printedAt > 0 ? new Date(delayed.printedAt).toISOString() : null;
    return [{ symbol: asset.symbol, move: delayed.changePercent, price: delayed.price, printedAt }];
  });
}

function delayedNotice(names: readonly DelayedName[], assets: MarketHeatmapBoard["assets"], now: number): string {
  const bySymbol = new Map(assets.map((asset) => [asset.symbol, asset]));
  const shown = names.slice(0, 8).map((name) => {
    const delayed = heatmapDelayedQuote(bySymbol.get(name.symbol)!);
    return `${name.symbol} ${delayed ? heatmapDelayedPrintTime(delayed, now) : "delayed"}`;
  }).join(", ");
  const rest = names.length > 8 ? ` and ${names.length - 8} more` : "";
  return `${names.length} of ${assets.length} names had no live price and are left out of the moves; their delayed figures are in metadata.delayed: ${shown}${rest}.`;
}

/**
 * When the board's figures are from, and whose sessions they follow: when its
 * prices printed, from a server that says (`pricesAsOf`). Otherwise, outside
 * the regular session the tiles are the completed session's, so the board is
 * as of that session's close (its date, from a server that does not send the
 * close); while it trades, the snapshot time, which is later than its prices.
 */
function boardObservation(board: Pick<MarketHeatmapBoard, "fetchedAt" | "regularSessionDate" | "regularSessionClosedAt" | "pricesAsOf">) {
  const closedAt = board.regularSessionDate ? board.regularSessionClosedAt : null;
  const pricedAt = typeof board.pricesAsOf === "number" && board.pricesAsOf > 0 ? board.pricesAsOf : closedAt;
  const asOf = typeof pricedAt === "number" && pricedAt > 0 ? new Date(pricedAt).toISOString()
    : board.regularSessionDate || new Date(board.fetchedAt).toISOString();
  return { asOf, sessionExchange: "NYSE" };
}

/**
 * How current the report's figures are. A Pro account's board is priced from a
 * live read and everyone else's is fifteen minutes behind. While the regular
 * session trades, a Pro board the server says is stale is stale, and one with
 * no name moving at all is delayed: it has no live read yet, or nothing has
 * traded since the open, so every figure it holds is a delayed one beside its
 * tile. Outside the session a Pro board reads as live, as before.
 */
function boardFreshness(result: Pick<MarketHeatmapBoard, "access" | "session" | "stale">, moved: number): HeadlessFreshnessStatus {
  if (result.access !== "realtime") return "delayed";
  if (result.session !== "REGULAR") return "live";
  if (result.stale) return "stale";
  return moved > 0 ? "live" : "delayed";
}

function projectRow(summary: HeatmapGroupSummary, groupBy: HeatmapGroupBy, whole = false) {
  return {
    group: whole ? "All" : summary.group ?? (summary.sector ? "No industry" : groupBy === "industry" ? "Unclassified" : "No sector"),
    ...(groupBy === "industry" ? { sector: summary.sector ?? "—" } : {}),
    names: summary.names,
    size: summary.size,
    sharePercent: summary.share * 100,
    move: summary.move,
    moved: summary.moved,
    up: summary.up,
    down: summary.down,
    unchanged: summary.unchanged,
    bestSymbol: summary.best?.symbol ?? null,
    bestMove: summary.best?.move ?? null,
    worstSymbol: summary.worst?.symbol ?? null,
    worstMove: summary.worst?.move ?? null,
  };
}

export const marketHeatmapHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  description: "The heat map's sectors or industries: each group's market-cap-weighted day move, how many names rose and fell, and its best and worst name, for the 500 largest US stocks or large US ETFs.",
  argument: { kind: "none" },
  options: [
    {
      key: "universe",
      description: "Board: the 500 largest US stocks, or large US ETFs (one group, as the ETF map has no sectors).",
      type: "enum",
      values: [
        { value: "us-equity", aliases: ["stocks", "equity", "us"] },
        { value: "us-etf", aliases: ["etf", "etfs"] },
      ],
      defaultValue: "us-equity",
      settingKey: "universe",
    },
    {
      key: "group",
      shot: { reportOnly: "groups the text report's table, and the map groups by sector itself" },
      description: "Group the stocks by sector, or by industry within each sector.",
      type: "enum",
      values: [{ value: "sector", aliases: ["sectors"] }, { value: "industry", aliases: ["industries"] }],
      defaultValue: "sector",
    },
  ],
  discovery: {
    aliases: ["HM", "heatmap"],
    dataRequirements: ["Gloom Cloud market heatmap snapshot"],
    limitations: [
      "The snapshot the pane starts from: real-time with Pro, fifteen minutes behind otherwise; the pane's live-streamed colors are not in the report.",
      "On a real-time board, a name the server had no live price for is left out of the moves and listed with its delayed figures and when they printed.",
      "Sizes, shares and the weighted move use market cap (net assets for ETFs), not the pane's tile area, which follows its Size by setting (the day's move by default).",
    ],
  },
  // A board snapshot refreshed on a schedule, not a feed; the pane streams on top of it, the report does not.
  // A completed session it names only by its date is a US trading day.
  freshness: { status: "delayed", tradingDayMarket: "US" },
  describe: (args) => {
    const universe = MARKET_HEATMAP_UNIVERSES.find((entry) => entry.id === args.options.universe)?.label ?? "US Stocks";
    return args.options.universe === "us-etf" ? `Market Heatmap | ${universe}` : `Market Heatmap | ${universe} by ${String(args.options.group)}`;
  },
  async load(args, ctx) {
    const universe: MarketHeatmapUniverseId = args.options.universe === "us-etf" ? "us-etf" : "us-equity";
    const groupBy: HeatmapGroupBy = args.options.group === "industry" ? "industry" : "sector";
    const result = await fetchMarketHeatmap(
      universe,
      { count: MARKET_HEATMAP_REQUEST_COUNT[universe], forceRefresh: ctx.refresh },
      { client: ctx.apiClient },
    );
    ctx.signal.throwIfAborted();
    const { grouping, groups, board } = summarizeHeatmapGroups(result.assets, groupBy);
    const flat = grouping === "flat";
    const delayed = delayedNames(result.assets);
    const delayedSymbols = new Set(delayed.map((name) => name.symbol));
    const noMove = result.assets.filter((asset) => heatmapMove(asset) == null && !delayedSymbols.has(asset.symbol)).map((asset) => asset.symbol);
    const covered = result.assets.length > 0 && board.moved / board.names >= MIN_MOVE_COVERAGE;
    const notices = [
      ...(delayed.length > 0 ? [delayedNotice(delayed, result.assets, Date.now())] : []),
      ...(noMove.length > 0 ? [noMoveNotice(noMove, result.assets.length)] : []),
    ];
    return {
      columns: columns(universe, groupBy, flat),
      rows: groups.map((summary) => projectRow(summary, groupBy, flat)),
      complete: !result.stale && covered,
      freshness: { status: boardFreshness(result, board.moved), tradingDayMarket: "US" },
      unavailableSymbols: covered ? [] : [...delayedSymbols, ...noMove],
      metadata: {
        universe,
        groupBy: flat ? null : groupBy,
        ...boardObservation(result),
        stale: result.stale === true,
        session: result.session ?? null,
        regularSessionDate: result.regularSessionDate ?? null,
        names: result.assets.length,
        noMove,
        delayed,
        ...(notices.length > 0 ? { notices } : {}),
        board: projectRow(board, groupBy, true),
        unit: "move and sharePercent in percent; size in USD",
        weighting: universe === "us-etf"
          ? "Each group's move is its names' day moves weighted by net assets, over the names with a move."
          : "Each group's move is its names' day moves weighted by market cap, over the names with a move.",
      },
    };
  },
};
