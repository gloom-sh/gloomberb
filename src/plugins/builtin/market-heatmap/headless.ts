import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { formatCompact, formatPercentRaw } from "../../../utils/format";
import { MARKET_HEATMAP_REQUEST_COUNT, MARKET_HEATMAP_UNIVERSES, fetchMarketHeatmap, type MarketHeatmapUniverseId } from "./data";
import { heatmapMove, summarizeHeatmapGroups, type HeatmapGroupBy, type HeatmapGroupSummary } from "./model";

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
    ...(flat ? [] : [{ key: "sharePercent", header: "Share", align: "right" as const, format: share }]),
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
  description: "The heat map's sectors or industries: each group's size-weighted day move, how many names rose and fell, and its best and worst name, for the 500 largest US stocks or large US ETFs.",
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
      "The snapshot the pane starts from, refreshed about once a minute; the pane's live-streamed colors are not in the report",
      "Moves are weighted by market cap (net assets for ETFs), not by the pane's square-root tile area",
    ],
  },
  // A board snapshot refreshed on a schedule, not a feed; the pane streams on top of it, the report does not.
  freshness: { status: "delayed" },
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
    const noMove = result.assets.filter((asset) => heatmapMove(asset) == null).map((asset) => asset.symbol);
    const covered = result.assets.length > 0 && board.moved / board.names >= MIN_MOVE_COVERAGE;
    return {
      columns: columns(universe, groupBy, flat),
      rows: groups.map((summary) => projectRow(summary, groupBy, flat)),
      complete: !result.stale && covered,
      unavailableSymbols: covered ? [] : noMove,
      metadata: {
        universe,
        groupBy: flat ? null : groupBy,
        asOf: new Date(result.fetchedAt).toISOString(),
        stale: result.stale === true,
        session: result.session ?? null,
        regularSessionDate: result.regularSessionDate ?? null,
        names: result.assets.length,
        noMove,
        ...(noMove.length > 0 ? { notices: [noMoveNotice(noMove, result.assets.length)] } : {}),
        board: projectRow(board, groupBy, true),
        unit: "move and sharePercent in percent; size in USD",
        weighting: universe === "us-etf"
          ? "Each group's move is its names' day moves weighted by net assets, over the names with a move."
          : "Each group's move is its names' day moves weighted by market cap, over the names with a move.",
      },
    };
  },
};
