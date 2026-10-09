import type { PerpBoardRow, PerpHistoryPayload, PerpRankingsPayload } from "../../../api-client/perps";
import type { DataTableCell, DataTableColumn } from "../../../components";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import { getTableWidth } from "../../../components/ui/table-layout";
import { formatCompact } from "../../../utils/format";
import type { ThemeColors } from "../../../theme/colors";
export const PERP_TABS = ["board", "rankings", "compare", "history", "evidence"] as const;
export type PerpTab = typeof PERP_TABS[number];
/** One market's tabs; the others list many markets. */
export const isMarketTab = (tab: string) => tab === "history" || tab === "evidence";
/** A named market opens its history; nothing named opens the board. */
export const openingTab = (market: string | null | undefined): PerpTab => market?.trim() ? "history" : "board";
export const ASSET_FILTERS = ["all", "stocks", "indices", "energy", "metals", "fx", "crypto"] as const;
export const VENUES = ["hyperliquid", "binance", "bybit", "okx", "deribit", "coinbase", "kraken", "dydx"] as const;
export const BOARD_SORTS = ["oi", "funding", "oi-change", "premium"] as const;
export const sortLabel = (sort: string) => ({ oi: "OI", funding: "Funding", "oi-change": "OI change", premium: "Premium" })[sort] ?? sort;
export const label = (s: string) => s === "fx" ? "FX" : s.charAt(0).toUpperCase() + s.slice(1);
export const percent = (n: number | null | undefined, digits = 3) => n == null ? "--" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
export const price = (n: number | null | undefined) => n == null ? "--" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 });
export const compact = (n: number | null | undefined) => n == null ? "--" : formatCompact(n, { fixedDecimals: true });
export const time = (s: string | null | undefined) => s ? `${s.slice(0, 10)} ${s.slice(11, 16)} UTC` : "--";
/** A list row's observation, month to minute: the header names UTC and the footer the full as-of. */
const observed = (s: string | null | undefined) => s ? `${s.slice(5, 10)} ${s.slice(11, 16)}` : "--";
export const marketLabel = (row: PerpBoardRow) => row.dex && row.dex !== "default" ? `${row.baseAsset} · ${row.dex.toUpperCase()}` : row.baseAsset;
export const fundingInterval = (row: Pick<PerpBoardRow, "fundingIntervalHours" | "fundingKind">) => row.fundingIntervalHours ? `${row.fundingIntervalHours}h${row.fundingKind === "last-paid" ? " paid" : row.fundingKind === "continuous" ? " continuous" : ""}` : "--";
export type HistoryMetric = "funding" | "oi" | "premium" | "price";
export function historyRows(data: PerpHistoryPayload | null | undefined, metric: HistoryMetric) {
  if (!data) return [];
  const points = metric === "funding" && data.funding.length ? data.funding.map((row) => ({ time: row.time, value: row.rate * 8 / row.intervalHours, basis: `Paid · ${row.intervalHours}h → 8h` }))
    : metric === "price" && data.candles.length ? data.candles.map((row) => ({ time: row.time, value: row.close, basis: "1h close" }))
      : data.rows.map((row) => ({ time: row.time,
        value: metric === "oi" ? row.openInterestUsd : metric === "premium" ? row.premium : metric === "price" ? row.markPrice
          : row.fundingRate !== null && row.fundingIntervalHours ? row.fundingRate * 8 / row.fundingIntervalHours : null,
        basis: `${row.resolution} snapshot${metric === "funding" && row.fundingIntervalHours ? ` · ${row.fundingIntervalHours}h → 8h` : ""}` }));
  return points.sort((a, b) => a.time.localeCompare(b.time)).map((row, i, all) => ({ ...row,
    change: i && row.value !== null && all[i - 1]!.value !== null ? row.value - all[i - 1]!.value! : null }));
}
export const historyValue = (n: number | null | undefined, metric: HistoryMetric) => metric === "oi" ? compact(n) : metric === "price" ? price(n) : percent(n, metric === "funding" ? 4 : 3);
export function historySeries(data: PerpHistoryPayload | null | undefined, metric: HistoryMetric, name: string, color: string) {
  const rows = historyRows(data, metric);
  return [staticSeries(rows.map((row) => scalarPoint(new Date(row.time), row.value)), { id: `perp-${metric}`, label: `${name} · ${historyCaption(data, metric)}`, color, calendarSpaced: true })];
}

export const venueName = (venue: string) => ({ hyperliquid: "Hyperliquid", binance: "Binance", bybit: "Bybit", okx: "OKX", deribit: "Deribit", coinbase: "Coinbase International", kraken: "Kraken", dydx: "dYdX" } as Record<string, string>)[venue] ?? venue;
export const venueLabel = (row: Pick<PerpBoardRow, "venue">) => venueName(row.venue);
/** The venues behind some rows, in a stable order: the citation for a report over many markets. */
export const venuesOf = (rows: readonly Pick<PerpBoardRow, "venue">[]): string[] => [...new Set<string>(rows.map((row) => row.venue))].sort((a, b) => venueName(a).localeCompare(venueName(b)));

// One text per figure, shared by the pane cells and the text report so the two always agree.
const markText = (row: Pick<PerpBoardRow, "markPrice" | "quoteCurrency">) => row.markPrice == null ? "--" : `${price(row.markPrice)} ${row.quoteCurrency}`;
const fundingPerInterval = (row: Pick<PerpBoardRow, "fundingRate" | "fundingIntervalHours" | "fundingKind">) => row.fundingRate == null ? "--" : `${percent(row.fundingRate, 5)} /${fundingInterval(row)}`;
/** Percentage points between two fractions: 0.00003 reads 0.0030pp. */
const points = (n: number | null | undefined, digits = 4) => n == null ? "--" : `${(n * 100).toFixed(digits)}pp`;

export type PerpColumnId = "market" | "venue" | "symbol" | "markPrice" | "fundingRate" | "fundingRate8h" | "fundingApr" | "premium"
  | "openInterestUsd" | "oiChange24h" | "priceChange24h" | "observedAt" | "value";
const PERP_COLUMNS: Record<PerpColumnId, DataTableColumn> = {
  market: { id: "market", label: "Market", width: 14, align: "left" },
  venue: { id: "venue", label: "Venue", width: 11, align: "left" },
  symbol: { id: "symbol", label: "Contract", width: 14, align: "left" },
  markPrice: { id: "markPrice", label: "Mark", width: 16, align: "right" },
  fundingRate: { id: "fundingRate", label: "Funding %/int", width: 14, align: "right" },
  fundingRate8h: { id: "fundingRate8h", label: "Funding 8h %", width: 12, align: "right" },
  fundingApr: { id: "fundingApr", label: "APR %", width: 9, align: "right" },
  premium: { id: "premium", label: "Premium %", width: 9, align: "right" },
  openInterestUsd: { id: "openInterestUsd", label: "OI USD", width: 8, align: "right" },
  oiChange24h: { id: "oiChange24h", label: "OI 24h %", width: 8, align: "right" },
  priceChange24h: { id: "priceChange24h", label: "24h %", width: 7, align: "right" },
  observedAt: { id: "observedAt", label: "Observed UTC", width: 12, align: "left" },
  value: { id: "value", label: "Value %", width: 10, align: "right" },
};
// Columns in reading order, then the order a narrow pane gives them up in.
export const BOARD_COLUMNS: PerpColumnId[] = ["market", "venue", "markPrice", "fundingRate", "fundingApr", "premium", "openInterestUsd", "oiChange24h", "priceChange24h", "observedAt"];
// The venue goes last: the same market trades on several, and only the venue tells those rows apart.
const BOARD_DROPS: PerpColumnId[] = ["observedAt", "priceChange24h", "fundingApr", "oiChange24h", "premium", "markPrice", "openInterestUsd", "venue"];
export const COMPARE_COLUMNS: PerpColumnId[] = ["venue", "symbol", "markPrice", "fundingRate", "fundingRate8h", "fundingApr", "premium", "openInterestUsd", "oiChange24h", "observedAt"];
const COMPARE_DROPS: PerpColumnId[] = ["observedAt", "oiChange24h", "fundingApr", "fundingRate", "premium", "markPrice", "openInterestUsd", "symbol"];
export const RANKING_COLUMNS: PerpColumnId[] = ["market", "venue", "value", "openInterestUsd"];

/** The columns that fit the pane, the least read going first; before the last of them goes, a long market name gives up its tail. */
function fitPerpColumns(ids: readonly PerpColumnId[], drops: readonly PerpColumnId[], width: number): DataTableColumn[] {
  let kept = ids.map((id) => PERP_COLUMNS[id]);
  const fits = () => getTableWidth(kept) <= width;
  for (const [index, drop] of drops.entries()) {
    if (fits()) break;
    if (index === drops.length - 1) {
      kept = kept.map((column) => column.id === "market" ? { ...column, width: 10 } : column);
      if (fits()) break;
    }
    kept = kept.filter((column) => column.id !== drop);
  }
  return kept;
}
export const boardColumns = (width: number) => fitPerpColumns(BOARD_COLUMNS, BOARD_DROPS, width);
export const compareColumns = (width: number) => fitPerpColumns(COMPARE_COLUMNS, COMPARE_DROPS, width);
export const rankingColumns = (width: number) => fitPerpColumns(RANKING_COLUMNS, ["openInterestUsd", "venue"], width);
export const perpColumnLabel = (id: PerpColumnId) => PERP_COLUMNS[id].label;

const SIGNED: Partial<Record<PerpColumnId, number>> = { fundingRate8h: 4, fundingApr: 2, premium: 3, oiChange24h: 2, priceChange24h: 2 };
/** A board or comparison cell: the text the report prints, the number CSV exports, and the sign's tone. */
export function perpCellText(row: PerpBoardRow, id: PerpColumnId): string {
  if (id === "market") return marketLabel(row);
  if (id === "venue") return venueLabel(row);
  if (id === "symbol") return row.symbol;
  if (id === "markPrice") return markText(row);
  if (id === "fundingRate") return fundingPerInterval(row);
  if (id === "openInterestUsd") return compact(row.openInterestUsd);
  if (id === "observedAt") return observed(row.observedAt);
  const digits = SIGNED[id];
  return digits === undefined ? "--" : percent(row[id as keyof PerpBoardRow] as number | null, digits);
}
export function perpCell(row: PerpBoardRow, id: PerpColumnId, colors: Pick<ThemeColors, "positive" | "negative" | "text" | "textBright" | "textMuted" | "textDim">): DataTableCell {
  const text = perpCellText(row, id);
  if (id === "market") return { text, color: row.stale ? colors.textDim : colors.textBright };
  if (id === "venue" || id === "symbol") return { text, color: colors.textMuted };
  if (id === "observedAt") return { text, value: row.observedAt, color: row.stale ? colors.textMuted : colors.textDim };
  if (id === "markPrice") return { text, value: row.markPrice };
  if (id === "openInterestUsd") return { text, value: row.openInterestUsd };
  const value = id === "fundingRate" ? row.fundingRate : row[id as keyof PerpBoardRow] as number | null;
  return { text, value: value == null ? null : value * 100, color: value == null || value === 0 ? colors.textMuted : value > 0 ? colors.positive : colors.negative };
}

/** The five ranked lists, each with the figure it ranks by. */
export type RankingKey = Exclude<keyof PerpRankingsPayload, "status" | "asOf" | "access" | "locked">;
export const RANKINGS: Array<{ key: RankingKey; label: string; header: string; field: "fundingRate8h" | "oiChange24h" | "premium" | "closedMarketPremium"; digits: number }> = [
  { key: "fundingPositive", label: "Highest Funding 8h", header: "Funding 8h %", field: "fundingRate8h", digits: 4 },
  { key: "fundingNegative", label: "Lowest Funding 8h", header: "Funding 8h %", field: "fundingRate8h", digits: 4 },
  { key: "oiSurges", label: "OI Surges 24h", header: "OI 24h %", field: "oiChange24h", digits: 2 },
  { key: "premiumDislocations", label: "Premium Dislocations", header: "Premium %", field: "premium", digits: 3 },
  { key: "closedMarketDislocations", label: "Closed-Market Dislocations", header: "Closed-market premium %", field: "closedMarketPremium", digits: 3 },
];
/** Rows per list: the preview's three, or the first ten of the full ranking. */
const RANKING_ROWS = 10;
export const rankingRows = (data: PerpRankingsPayload | null | undefined, key: RankingKey) => (data?.[key] ?? []).slice(0, RANKING_ROWS);

/**
 * Highest minus lowest 8h funding across the shown contracts, in percentage points. Each end is named by its
 * venue, with the contract symbol when that venue lists more than one.
 */
export function fundingSpread(rows: readonly PerpBoardRow[]) {
  const rated = rows.filter((row) => row.fundingRate8h != null);
  if (rated.length < 2) return null;
  const high = rated.reduce((best, row) => row.fundingRate8h! > best.fundingRate8h! ? row : best);
  const low = rated.reduce((best, row) => row.fundingRate8h! < best.fundingRate8h! ? row : best);
  const name = (row: PerpBoardRow) => rated.filter((other) => other.venue === row.venue).length > 1 ? `${venueLabel(row)} ${row.symbol}` : venueLabel(row);
  return { value: high.fundingRate8h! - low.fundingRate8h!, high, low, text: points(high.fundingRate8h! - low.fundingRate8h!), detail: `${name(high)} over ${name(low)}` };
}


export function historyColumns(metric: HistoryMetric, currency: string, hasCandles = true): DataTableColumn[] {
  return [
    { id: "time", label: "Time (UTC)", width: 19, flexGrow: 1, align: "left" },
    { id: "value", label: metric === "funding" ? "Funding 8h %" : metric === "premium" ? "Oracle premium %" : metric === "oi" ? "OI USD" : `${hasCandles ? "Close" : "Mark"} ${currency}`, width: 17, align: "right" },
    { id: "change", label: metric === "funding" || metric === "premium" ? "Change pp" : `Change ${metric === "oi" ? "USD" : currency}`, width: 17, align: "right" },
    { id: "basis", label: "Observation basis", width: 25, align: "left" },
  ];
}
export const historyChange = (value: number | null | undefined, metric: HistoryMetric) => value == null ? "--" : metric === "funding" || metric === "premium" ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(metric === "funding" ? 4 : 3)}pp` : historyValue(value, metric);
export function historyCaption(data: PerpHistoryPayload | null | undefined, metric: HistoryMetric) {
  return metric === "funding" ? data?.funding.length ? "Paid funding / 8h" : "Observed funding / 8h"
    : metric === "price" && data?.candles.length ? "Hourly trade closes" : metric === "oi" ? "Collected open interest" : metric === "premium" ? "Collected oracle premium" : "Collected mark";
}

export function historyCell(row: ReturnType<typeof historyRows>[number], column: string, metric: HistoryMetric, colors?: Pick<ThemeColors, "positive" | "negative" | "textMuted" | "textDim" | "textBright">): DataTableCell {
  // The header says UTC; each row only needs the day and the hour.
  if (column === "time") return { text: row.time.slice(0, 16).replace("T", " "), value: row.time };
  if (column === "basis") return { text: row.basis, color: colors?.textDim };
  const value = column === "change" ? row.change : row.value;
  return { text: column === "change" ? historyChange(value, metric) : historyValue(value, metric),
    value: value === null ? null : value * (metric === "funding" || metric === "premium" ? 100 : 1),
    color: !colors ? undefined : column === "change" ? value == null || value === 0 ? colors.textMuted : value > 0 ? colors.positive : colors.negative : colors.textBright };
}
