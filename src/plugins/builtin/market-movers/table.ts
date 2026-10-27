import type { DataTableCell } from "../../../components";
import { withCompanyLogo } from "../../../components/company-logo";
import { getTableWidth } from "../../../components/ui/table-layout";
import { TextAttributes } from "../../../ui";
import { colors, priceColor } from "../../../theme/colors";
import { formatCompact, formatPercentRaw } from "../../../utils/format";
import { extendedSessionStateLabel, type ExtendedSession } from "../../../market-data/market/status";
import type { MarketMoverColumn, MarketMoverRow } from "./model";
import { fiftyTwoWeekPositionPercent, formatMoverPrice, moverExtendedMove, moverReferencePrice } from "./model";

export function formatVolRatio(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio) || ratio < 0) return "—";
  if (ratio >= 10) return `${Math.round(ratio)}x`;
  return `${ratio.toFixed(1)}x`;
}

export function volRatioColor(ratio: number | null): string {
  if (ratio != null && ratio >= 3) return colors.textBright;
  if (ratio != null && ratio >= 1.5) return colors.text;
  return colors.textDim;
}

function fiftyTwoWeekPosition(price: number | null, low: number | undefined, high: number | undefined): string {
  const pct = fiftyTwoWeekPositionPercent(price, low, high);
  return pct == null ? "—" : `${Math.round(pct)}%`;
}

const EXTENDED_COLUMN_WIDTH = 9;
/** With an extended or float column, a narrow pane drops MCAP, then 52W%, before the name gets narrower than this. */
const EXTENDED_MIN_NAME_WIDTH = 12;

/**
 * The list's columns at `width`. A pre-market or after-hours column follows
 * CHG% for each session in `extendedSessions`, and FLOAT ends the row while a
 * minimum float is set (`float`); to make room for them a narrow pane gives up
 * MCAP, then 52W%, before it cuts the names short.
 */
export function buildMarketMoverColumns(
  width: number,
  extendedSessions: readonly ExtendedSession[] = [],
  options: { float?: boolean } = {},
): MarketMoverColumn[] {
  const lead: MarketMoverColumn[] = [
    { id: "rank", label: "#", width: 3, align: "left" },
    { id: "symbol", label: "TICKER", width: 8, align: "left" },
  ];
  const quote: MarketMoverColumn[] = [
    { id: "price", label: "LAST", width: 11, align: "right" },
    { id: "changePercent", label: "CHG%", width: 9, align: "right" },
    ...extendedSessions.map((session): MarketMoverColumn => ({
      id: session === "PRE" ? "preMarket" : "afterHours",
      // Named for the session it trades in, as the header labels it.
      label: extendedSessionStateLabel(session),
      width: EXTENDED_COLUMN_WIDTH,
      align: "right",
    })),
  ];
  const trailing: MarketMoverColumn[] = [
    { id: "volume", label: "VOL", width: 8, align: "right" },
    { id: "volumeRatio", label: "V/AVG", width: 6, align: "right" },
    { id: "range", label: "52W%", width: 6, align: "right" },
    { id: "marketCap", label: "MCAP", width: 8, align: "right" },
    ...(options.float ? [{ id: "floatShares" as const, label: "FLOAT", width: 7, align: "right" as const }] : []),
  ];
  // Measured the way the table draws them (a header and its sort mark widen a
  // column, gaps between them); the name adds its own width and a gap.
  const nameRoom = () => width - getTableWidth([...lead, ...quote, ...trailing]) - 1;
  for (const id of ["marketCap", "range"] as const) {
    if ((extendedSessions.length === 0 && !options.float) || nameRoom() >= EXTENDED_MIN_NAME_WIDTH) break;
    trailing.splice(trailing.findIndex((column) => column.id === id), 1);
  }
  return [...lead, { id: "name", label: "NAME", width: Math.max(6, nameRoom()), align: "left" }, ...quote, ...trailing];
}

/** `logos`: the desktop and the web lead each name with the company's logo; the terminal draws none. */
export function renderMarketMoverCell(
  row: MarketMoverRow,
  column: MarketMoverColumn,
  logos = false,
): DataTableCell {
  switch (column.id) {
    case "rank":
      return { text: String(row.rank), color: colors.textDim };
    case "symbol":
      return {
        text: row.symbol,
        color: colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "name":
      return withCompanyLogo({ text: row.name }, row, logos);
    case "price":
      return { text: formatMoverPrice(row.price, row.currency, moverReferencePrice(row)) };
    case "changePercent":
      return {
        text: formatPercentRaw(row.changePercent ?? undefined),
        value: row.changePercent,
        color: priceColor(row.changePercent ?? 0),
      };
    case "preMarket":
    case "afterHours": {
      // The extended print's move from the close in LAST.
      const move = moverExtendedMove(row, column.id === "preMarket" ? "PRE" : "POST");
      return {
        text: formatPercentRaw(move ?? undefined),
        value: move,
        color: move == null ? colors.textDim : priceColor(move),
      };
    }
    case "volume":
      return { text: formatCompact(row.volume ?? undefined, { fixedDecimals: true }), value: row.volume, color: colors.textDim };
    case "volumeRatio":
      return {
        text: formatVolRatio(row.volumeRatio),
        value: row.volumeRatio != null && row.volumeRatio >= 0 ? row.volumeRatio : null,
        color: volRatioColor(row.volumeRatio),
      };
    case "range":
      return {
        text: fiftyTwoWeekPosition(row.price, row.fiftyTwoWeekLow, row.fiftyTwoWeekHigh),
        value: fiftyTwoWeekPositionPercent(row.price, row.fiftyTwoWeekLow, row.fiftyTwoWeekHigh),
        color: colors.textDim,
      };
    case "marketCap":
      return {
        text: row.marketCap != null ? formatCompact(row.marketCap, { fixedDecimals: true }) : "—",
        value: row.marketCap,
        color: colors.textDim,
      };
    case "floatShares":
      return {
        text: row.floatShares != null ? formatCompact(row.floatShares, { fixedDecimals: true }) : "—",
        value: row.floatShares ?? null,
        color: colors.textDim,
      };
  }
}
