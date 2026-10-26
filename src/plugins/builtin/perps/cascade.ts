import type { PerpDepthPayload, PerpDepthRow, PerpDepthSnapshot, PerpLiquidationMarket, PerpLiquidationPrint, PerpLiquidationsPayload } from "../../../api-client/perps";
import type { DataTableCell, DataTableColumn, StatItem } from "../../../components";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import { getTableWidth } from "../../../components/ui/table-layout";
import type { HeadlessPaneFreshness } from "../../../types/headless";
import type { ThemeColors } from "../../../theme/colors";
import { compact, price, venueName } from "./model";

// Liquidations and order book depth of one base asset across the venues: the Liquidations and Depth tabs, their
// text report and their charts read these, so the pane and `fn PERP` always agree.

type Colors = Pick<ThemeColors, "positive" | "negative" | "text" | "textBright" | "textMuted" | "textDim">;
/** Month to second, or to minute: the header names UTC. */
const stamp = (s: string | null | undefined, seconds = false) => s ? `${s.slice(5, 10)} ${s.slice(11, seconds ? 19 : 16)}` : "--";
const venueOrder = (venue: string) => { const at = ["binance", "bybit", "okx", "hyperliquid"].indexOf(venue); return at < 0 ? 9 : at; };
/** The venues behind some rows, in the order the tabs list them. */
const venuesIn = (rows: readonly { venue: string }[]) => [...new Set(rows.map((row) => row.venue))].sort((a, b) => venueOrder(a) - venueOrder(b));
const usd = (n: number | null | undefined) => n == null ? "--" : compact(n);

/**
 * The columns that fit the pane, the least read going first. A pair (a band's bid and ask, a window's longs and
 * shorts) goes together; the venue and the contract stay, since only both tell one venue's contracts apart.
 */
function fit<Id extends string>(columns: Record<Id, DataTableColumn>, ids: readonly Id[], drops: readonly (readonly Id[])[], width: number): DataTableColumn[] {
  let kept = ids.map((id) => columns[id]);
  for (const drop of drops) {
    if (getTableWidth(kept) <= width) break;
    kept = kept.filter((column) => !(drop as readonly string[]).includes(column.id));
  }
  return kept;
}

// ---- Liquidations ----

export type LiquidationView = "contracts" | "prints";
export const LIQUIDATION_VIEWS: Array<{ value: LiquidationView; label: string }> = [{ value: "contracts", label: "By contract" }, { value: "prints", label: "Largest" }];

export type LiquidationColumnId = "venue" | "symbol" | "long24h" | "short24h" | "long7d" | "short7d" | "count24h" | "lastEventAt";
const LIQUIDATION_COLUMNS: Record<LiquidationColumnId, DataTableColumn> = {
  venue: { id: "venue", label: "Venue", width: 11, align: "left" },
  symbol: { id: "symbol", label: "Contract", width: 14, align: "left" },
  long24h: { id: "long24h", label: "Longs 24h USD", width: 13, align: "right" },
  short24h: { id: "short24h", label: "Shorts 24h USD", width: 14, align: "right" },
  long7d: { id: "long7d", label: "Longs 7d USD", width: 12, align: "right" },
  short7d: { id: "short7d", label: "Shorts 7d USD", width: 13, align: "right" },
  count24h: { id: "count24h", label: "Events 24h", width: 10, align: "right" },
  lastEventAt: { id: "lastEventAt", label: "Last UTC", width: 11, align: "left" },
};
export const LIQUIDATION_COLUMN_IDS: LiquidationColumnId[] = ["venue", "symbol", "long24h", "short24h", "long7d", "short7d", "count24h", "lastEventAt"];
export const liquidationColumns = (width: number) => fit(LIQUIDATION_COLUMNS, LIQUIDATION_COLUMN_IDS, [["lastEventAt"], ["count24h"], ["long7d", "short7d"]], width);
export const liquidationColumnLabel = (id: LiquidationColumnId) => LIQUIDATION_COLUMNS[id].label;

/** A contract's liquidations: longs liquidated are forced sells (negative), shorts forced buys (positive). */
export function liquidationCellText(row: PerpLiquidationMarket, id: LiquidationColumnId): string {
  if (id === "venue") return venueName(row.venue);
  if (id === "symbol") return row.symbol;
  if (id === "count24h") return row.count24h.toLocaleString("en-US");
  if (id === "lastEventAt") return stamp(row.lastEventAt);
  return usd(row[id]);
}
export function liquidationCell(row: PerpLiquidationMarket, id: LiquidationColumnId, colors: Colors): DataTableCell {
  const text = liquidationCellText(row, id);
  if (id === "venue") return { text, color: colors.textBright };
  if (id === "symbol") return { text, color: colors.textMuted };
  if (id === "lastEventAt") return { text, value: row.lastEventAt, color: colors.textDim };
  if (id === "count24h") return { text, value: row.count24h, color: row.count24h ? colors.text : colors.textMuted };
  const value = row[id];
  return { text, value, color: !value ? colors.textMuted : id.startsWith("long") ? colors.negative : colors.positive };
}

export type PrintColumnId = "eventAt" | "venue" | "symbol" | "side" | "price" | "priceKind" | "quantity" | "notionalUsd" | "receivedAt";
const printColumnsFor = (base: string): Record<PrintColumnId, DataTableColumn> => ({
  eventAt: { id: "eventAt", label: "Time UTC", width: 14, align: "left" },
  venue: { id: "venue", label: "Venue", width: 11, align: "left" },
  symbol: { id: "symbol", label: "Contract", width: 14, align: "left" },
  side: { id: "side", label: "Side", width: 5, align: "left" },
  price: { id: "price", label: "Price", width: 12, align: "right" },
  priceKind: { id: "priceKind", label: "Price basis", width: 11, align: "left" },
  quantity: { id: "quantity", label: `Size ${base}`.slice(0, 14), width: Math.max(8, Math.min(14, base.length + 5)), align: "right" },
  notionalUsd: { id: "notionalUsd", label: "Notional USD", width: 12, align: "right" },
  receivedAt: { id: "receivedAt", label: "Received UTC", width: 12, align: "left" },
});
export const PRINT_COLUMN_IDS: PrintColumnId[] = ["eventAt", "venue", "symbol", "side", "notionalUsd", "price", "priceKind", "quantity", "receivedAt"];
export const printColumns = (width: number, base: string) => fit(printColumnsFor(base), PRINT_COLUMN_IDS, [["receivedAt"], ["quantity"], ["priceKind"], ["price"]], width);
export const printColumnLabel = (id: PrintColumnId, base: string) => printColumnsFor(base)[id].label;
export const printKey = (row: PerpLiquidationPrint) => `${row.marketId}:${row.eventAt}:${row.side}:${row.price}:${row.quantity}`;

export function printCellText(row: PerpLiquidationPrint, id: PrintColumnId): string {
  if (id === "eventAt") return stamp(row.eventAt, true);
  if (id === "receivedAt") return row.receivedAt.slice(11, 19);
  if (id === "venue") return venueName(row.venue);
  if (id === "symbol") return row.symbol;
  if (id === "side") return row.side === "long" ? "Long" : "Short";
  if (id === "price") return price(row.price);
  if (id === "priceKind") return row.priceKind === "fill" ? "Fill" : "Bankruptcy";
  if (id === "quantity") return compact(row.quantity);
  return usd(row.notionalUsd);
}
export function printCell(row: PerpLiquidationPrint, id: PrintColumnId, colors: Colors): DataTableCell {
  const text = printCellText(row, id);
  const tone = row.side === "long" ? colors.negative : colors.positive;
  if (id === "eventAt") return { text, value: row.eventAt };
  if (id === "receivedAt") return { text, value: row.receivedAt, color: colors.textDim };
  if (id === "venue") return { text, color: colors.textBright };
  if (id === "symbol" || id === "priceKind") return { text, color: colors.textMuted };
  if (id === "side") return { text, color: tone };
  if (id === "price") return { text, value: row.price };
  if (id === "quantity") return { text, value: row.quantity };
  return { text, value: row.notionalUsd, color: tone };
}

const isRecent = (since: string | null, from: string) => !!since && Date.parse(since) > Date.parse(from);
/** The four totals; a window that reaches back before collection started says when it starts. */
export function liquidationFigures(data: PerpLiquidationsPayload, colors: Colors): StatItem[] {
  // The date only when collection started on another UTC day, so the detail fits beside every figure.
  const started = data.collectingSince?.slice(0, 10) === data.asOf.slice(0, 10) ? data.collectingSince.slice(11, 16) : stamp(data.collectingSince);
  const since = isRecent(data.collectingSince, data.from) ? `since ${started} UTC` : undefined;
  const day = isRecent(data.collectingSince, new Date(Date.parse(data.asOf) - 86_400_000).toISOString()) ? since : undefined;
  // The tab and the chart's legend say these are liquidated positions; the label names the side and the window.
  const figure = (id: "long24h" | "short24h" | "long7d" | "short7d", label: string, detail?: string): StatItem =>
    ({ id, label, value: usd(data.totals[id]), color: id.startsWith("long") ? colors.negative : colors.positive, ...(detail ? { detail, detailVariants: [""] } : {}) });
  return [figure("long24h", "Longs 24h", day), figure("short24h", "Shorts 24h", day), figure("long7d", "Longs 7d", since), figure("short7d", "Shorts 7d", since)];
}

/** Hourly liquidations as columns: shorts above zero, longs hanging below it, so the two sides of an hour never cover each other. */
export function liquidationSeries(data: PerpLiquidationsPayload | null | undefined, colors: Pick<ThemeColors, "positive" | "negative">) {
  const hours = data?.hourly ?? [];
  return [
    staticSeries(hours.map((hour) => scalarPoint(new Date(hour.time), hour.short)), { id: "liquidated-shorts", label: "Shorts liquidated", color: colors.positive, style: "columns", calendarSpaced: true }),
    staticSeries(hours.map((hour) => scalarPoint(new Date(hour.time), -hour.long)), { id: "liquidated-longs", label: "Longs liquidated", color: colors.negative, style: "columns", calendarSpaced: true }),
  ];
}
/** The hour a print falls in, where the chart's column for it stands. */
export const printHour = (row: PerpLiquidationPrint) => new Date(Math.floor(Date.parse(row.eventAt) / 3_600_000) * 3_600_000);

/** The streams that are down, with when each last reported: `Bybit stream down since 10-26 06:52 UTC`. Empty while every one is live. */
export function downStreams(data: Pick<PerpLiquidationsPayload, "streams">): string[] {
  return [...data.streams].sort((a, b) => venueOrder(a.venue) - venueOrder(b.venue)).filter((stream) => stream.state !== "live")
    .map((stream) => `${venueName(stream.venue)} stream down${stream.lastOkAt ? ` since ${stamp(stream.lastOkAt)} UTC` : ""}`);
}
/**
 * Who the figures come from and when they were counted: the venues' streams, tallied up to the server's time. Not a
 * feed: the tab counts again each minute. A stream that is down is said, since its venue's figures stop growing.
 */
export function liquidationFreshness(data: PerpLiquidationsPayload): HeadlessPaneFreshness {
  const venues = venuesIn(data.markets).map(venueName);
  const down = downStreams(data);
  return { ...(venues.length ? { source: venues.join(", ") } : {}), asOf: data.asOf, maxAgeMinutes: 10, ...(down.length ? { note: down.join("; ") } : {}) };
}

// ---- Depth ----

const DEPTH_BANDS = [{ key: "05", label: "0.5%", fraction: 0.005 }, { key: "1", label: "1%", fraction: 0.01 }, { key: "2", label: "2%", fraction: 0.02 }] as const;
type BandKey = typeof DEPTH_BANDS[number]["key"];
export type DepthColumnId = "venue" | "symbol" | "mid" | `bid${BandKey}` | `ask${BandKey}` | "reach" | "observedAt";
const DEPTH_COLUMNS: Record<DepthColumnId, DataTableColumn> = {
  venue: { id: "venue", label: "Venue", width: 11, align: "left" },
  symbol: { id: "symbol", label: "Contract", width: 14, align: "left" },
  mid: { id: "mid", label: "Mid", width: 12, align: "right" },
  bid05: { id: "bid05", label: "Bid 0.5% USD", width: 12, align: "right" },
  ask05: { id: "ask05", label: "Ask 0.5% USD", width: 12, align: "right" },
  bid1: { id: "bid1", label: "Bid 1% USD", width: 10, align: "right" },
  ask1: { id: "ask1", label: "Ask 1% USD", width: 10, align: "right" },
  bid2: { id: "bid2", label: "Bid 2% USD", width: 10, align: "right" },
  ask2: { id: "ask2", label: "Ask 2% USD", width: 10, align: "right" },
  reach: { id: "reach", label: "Book reach %", width: 12, align: "right" },
  observedAt: { id: "observedAt", label: "Observed UTC", width: 17, align: "left" },
};
export const DEPTH_COLUMN_IDS: DepthColumnId[] = ["venue", "symbol", "mid", "bid05", "ask05", "bid1", "ask1", "bid2", "ask2", "reach", "observedAt"];
export const depthColumns = (width: number) => fit(DEPTH_COLUMNS, DEPTH_COLUMN_IDS, [["reach"], ["mid"], ["observedAt"], ["bid2", "ask2"], ["bid05", "ask05"]], width);
export const depthColumnLabel = (id: DepthColumnId) => DEPTH_COLUMNS[id].label;

/** A band wider than the book the venue returned holds at least what the book shows: `≥57.58M`. */
const bandFraction = (id: string) => DEPTH_BANDS.find((band) => id.endsWith(band.key))!.fraction;
const isFloor = (row: Pick<PerpDepthSnapshot, "bidReach" | "askReach">, id: `${"bid" | "ask"}${BandKey}`) =>
  bandFraction(id) > (id.startsWith("bid") ? row.bidReach : row.askReach) + 1e-9;
/** How far the shorter side of the returned book reaches from mid. */
const bookReach = (row: Pick<PerpDepthSnapshot, "bidReach" | "askReach">) => Math.min(row.bidReach, row.askReach);
export function depthCellText(row: PerpDepthRow, id: DepthColumnId): string {
  if (id === "venue") return venueName(row.venue);
  if (id === "symbol") return row.symbol;
  if (id === "mid") return price(row.mid);
  if (id === "reach") return `${(bookReach(row) * 100).toFixed(2)}%`;
  // A book not read for 2.5 hours says so, since the band totals leave it out.
  if (id === "observedAt") return `${stamp(row.observedAt)}${row.stale ? " stale" : ""}`;
  return `${isFloor(row, id) ? "≥" : ""}${usd(row[id])}`;
}
export function depthCell(row: PerpDepthRow, id: DepthColumnId, colors: Colors): DataTableCell {
  const text = depthCellText(row, id);
  if (id === "venue") return { text, color: row.stale ? colors.textDim : colors.textBright };
  if (id === "symbol") return { text, color: colors.textMuted };
  if (id === "mid") return { text, value: row.mid };
  if (id === "reach") return { text, value: bookReach(row) * 100, color: colors.textMuted };
  if (id === "observedAt") return { text, value: row.observedAt, color: row.stale ? colors.textMuted : colors.textDim };
  return { text, value: row[id], color: row.stale ? colors.textMuted : id.startsWith("bid") ? colors.positive : colors.negative };
}

/**
 * Each band's resting bids and asks summed over the current books; `floor` when any of them ends inside the band. A stale
 * book (it left its venue's 50 largest, or the venue has been failing) is listed, marked, and not added to books read now.
 */
export function depthBandTotals(all: readonly PerpDepthRow[]) {
  const rows = all.filter((row) => !row.stale);
  if (!rows.length) return [];
  return DEPTH_BANDS.map((band) => ({ key: band.key, label: `±${band.label} of mid`, books: rows.length,
    bids: rows.reduce((sum, row) => sum + row[`bid${band.key}`], 0), asks: rows.reduce((sum, row) => sum + row[`ask${band.key}`], 0),
    floor: rows.some((row) => isFloor(row, `bid${band.key}`) || isFloor(row, `ask${band.key}`)) }));
}
export const depthFigures = (rows: readonly PerpDepthRow[]): StatItem[] => depthBandTotals(rows).map(({ key, label, bids, asks, floor }) => ({
  id: `band-${key}`, label, value: `${floor ? "≥" : ""}${usd(bids + asks)}`, detail: `bids ${usd(bids)} · asks ${usd(asks)}`, detailVariants: [`${usd(bids)} / ${usd(asks)}`, ""] }));

/** Said under the depth figures when a stale book is left out of them. */
export const depthStaleNote = (rows: readonly PerpDepthRow[]) => {
  const stale = rows.filter((row) => row.stale).length;
  return stale ? `${stale === 1 ? "One book" : `${stale} books`} not read for 2.5 hours ${stale === 1 ? "is" : "are"} marked stale and left out of the band totals.` : null;
};

/** One book's hourly bids and asks within 1% of mid, for the chart over the table. */
export function depthSeries(history: readonly PerpDepthSnapshot[], row: PerpDepthRow | null, colors: Pick<ThemeColors, "positive" | "negative">) {
  if (!row) return [];
  const points = history.filter((point) => point.marketId === row.marketId).sort((a, b) => a.bucket.localeCompare(b.bucket));
  const name = `${venueName(row.venue)} ${row.symbol}`;
  return [
    staticSeries(points.map((point) => scalarPoint(new Date(point.bucket), point.bid1)), { id: "depth-bids", label: `${name} bids 1%`, color: colors.positive, calendarSpaced: true }),
    staticSeries(points.map((point) => scalarPoint(new Date(point.bucket), point.ask1)), { id: "depth-asks", label: "asks 1%", color: colors.negative, calendarSpaced: true }),
  ];
}
export const depthHistoryCount = (history: readonly PerpDepthSnapshot[], marketId: string | undefined) => history.filter((point) => point.marketId === marketId).length;

/** Each venue's newest book: what the footer, the report and a capture are dated by. Stale after 2.5 hours, as the server marks a row. */
export function depthFreshness(data: Pick<PerpDepthPayload, "rows">): HeadlessPaneFreshness {
  const venues = venuesIn(data.rows);
  const sources = venues.map((venue) => ({ source: venueName(venue), asOf: data.rows.filter((row) => row.venue === venue).map((row) => row.observedAt).sort().at(-1)! }));
  return { ...(sources.length ? { source: sources.map((entry) => entry.source).join(", ") } : {}), sources, ageOnly: true, maxAgeMinutes: 150,
    observations: data.rows.map((row) => ({ observedAt: row.observedAt, stale: row.stale })), note: "order books read hourly" };
}
