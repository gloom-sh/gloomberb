import { TextAttributes } from "../../../ui";
import type { DataTableCell, DataTableColumn } from "../../../components";
import type { EarningsEvent } from "../../../types/data-provider";
import { colors } from "../../../theme/colors";
import { formatCompact, formatNumber, formatPercent } from "../../../utils/format";
import type { EarningsDisplayRow } from "./model";

type EarningsColumnId =
  | "date"
  | "when"
  | "status"
  | "symbol"
  | "name"
  | "epsEstimate"
  | "epsRange"
  | "epsGrowth"
  | "epsTrend"
  | "epsRevisions"
  | "revenueEstimate"
  | "revenueRange"
  | "revenueGrowth"
  | "analysts";

export type EarningsColumn = DataTableColumn & { id: EarningsColumnId };

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function formatDate(date: Date): string {
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function formatTime(date: Date | null | undefined): string {
  if (!date) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatMaybeNumber(value: number | null | undefined, decimals = 2): string {
  return value == null ? "—" : formatNumber(value, decimals);
}

function formatRange(
  low: number | null | undefined,
  high: number | null | undefined,
  formatter: (value: number) => string,
): string {
  if (low == null && high == null) return "—";
  return `${low == null ? "—" : formatter(low)}-${high == null ? "—" : formatter(high)}`;
}

function formatRevisionSummary(event: EarningsEvent): string {
  const up = event.epsRevisionUp30d;
  const down = event.epsRevisionDown30d;
  if (up == null && down == null) return "—";
  return `${up ?? "—"}/${down ?? "—"}`;
}

function formatAnalystSummary(event: EarningsEvent): string {
  const eps = event.epsAnalysts;
  const revenue = event.revenueAnalysts;
  if (eps == null && revenue == null) return "—";
  if (eps === revenue || revenue == null) return String(eps);
  if (eps == null) return String(revenue);
  return `${eps}/${revenue}`;
}

function estimateColor(value: number | null | undefined, selectedColor: string | undefined): string | undefined {
  if (selectedColor) return selectedColor;
  if (value == null) return colors.textDim;
  return value >= 0 ? colors.positive : colors.negative;
}

export function buildEarningsColumns(width: number): EarningsColumn[] {
  const dateWidth = 8;
  const whenWidth = 8;
  const statusWidth = 4;
  const symbolWidth = 8;
  const epsWidth = 8;
  const epsRangeWidth = 11;
  const growthWidth = 8;
  const trendWidth = 8;
  const revisionsWidth = 7;
  const revenueWidth = 9;
  const revenueRangeWidth = 13;
  const analystsWidth = 7;
  const columnCount = 14;
  const fixedWidth = dateWidth + whenWidth + statusWidth + symbolWidth + epsWidth
    + epsRangeWidth + growthWidth + trendWidth + revisionsWidth + revenueWidth
    + revenueRangeWidth + growthWidth + analystsWidth;
  const nameWidth = Math.max(14, width - 2 - columnCount - fixedWidth);

  return [
    { id: "date", label: "DATE", width: dateWidth, align: "left" },
    { id: "when", label: "WHEN", width: whenWidth, align: "left" },
    { id: "status", label: "ST", width: statusWidth, align: "left" },
    { id: "symbol", label: "TICKER", width: symbolWidth, align: "left" },
    { id: "name", label: "NAME", width: nameWidth, align: "left" },
    { id: "epsEstimate", label: "EPS", width: epsWidth, align: "right" },
    { id: "epsRange", label: "EPS RNG", width: epsRangeWidth, align: "right" },
    { id: "epsGrowth", label: "EPS YOY", width: growthWidth, align: "right" },
    { id: "epsTrend", label: "EPS 30D", width: trendWidth, align: "right" },
    { id: "epsRevisions", label: "REV 30D", width: revisionsWidth, align: "right" },
    { id: "revenueEstimate", label: "SALES", width: revenueWidth, align: "right" },
    { id: "revenueRange", label: "SALES RNG", width: revenueRangeWidth, align: "right" },
    { id: "revenueGrowth", label: "SALES YOY", width: growthWidth, align: "right" },
    { id: "analysts", label: "ANL", width: analystsWidth, align: "right" },
  ];
}

export function renderEarningsSectionHeader(row: EarningsDisplayRow) {
  if (row.kind !== "separator") return null;
  return {
    text: row.label,
    color: colors.textBright,
    attributes: TextAttributes.BOLD,
  };
}

export function renderEarningsCell(
  row: EarningsDisplayRow,
  column: EarningsColumn,
  selected: boolean,
): DataTableCell {
  if (row.kind !== "event") return { text: "" };

  const selectedColor = selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "date":
      return { text: formatDate(row.event.earningsDate), color: selectedColor ?? colors.textDim };
    case "when":
      return {
        text: row.event.timing || formatTime(row.event.earningsCallDate),
        color: selectedColor ?? colors.textDim,
      };
    case "status":
      if (row.event.isDateEstimate == null) {
        return {
          text: "—",
          color: selectedColor ?? colors.textDim,
        };
      }
      return {
        text: row.event.isDateEstimate === true ? "est" : "firm",
        color: selectedColor ?? (row.event.isDateEstimate === true ? colors.warning : colors.textDim),
      };
    case "symbol":
      return {
        text: row.event.symbol,
        color: selectedColor ?? colors.text,
        attributes: TextAttributes.BOLD,
      };
    case "name":
      return { text: row.event.name, color: selectedColor ?? colors.text };
    case "epsEstimate":
      return {
        text: formatMaybeNumber(row.event.epsEstimate),
        color: selectedColor ?? colors.textDim,
      };
    case "epsRange":
      return {
        text: formatRange(row.event.epsLow, row.event.epsHigh, (value) => formatNumber(value, 2)),
        color: selectedColor ?? colors.textDim,
      };
    case "epsGrowth":
      return {
        text: row.event.epsGrowth != null ? formatPercent(row.event.epsGrowth) : "—",
        color: estimateColor(row.event.epsGrowth, selectedColor),
      };
    case "epsTrend": {
      const current = row.event.epsEstimate;
      const prior = row.event.epsTrend30dAgo;
      const change = current != null && prior != null ? current - prior : null;
      return {
        text: change != null ? formatNumber(change, 2) : "—",
        color: estimateColor(change, selectedColor),
      };
    }
    case "epsRevisions": {
      const up = row.event.epsRevisionUp30d;
      const down = row.event.epsRevisionDown30d;
      const net = up != null && down != null ? up - down : null;
      return {
        text: formatRevisionSummary(row.event),
        color: selectedColor ?? (net != null && net > 0 ? colors.positive : net != null && net < 0 ? colors.negative : colors.textDim),
      };
    }
    case "revenueEstimate":
      return {
        text: row.event.revenueEstimate != null ? formatCompact(row.event.revenueEstimate) : "—",
        color: selectedColor ?? colors.textDim,
      };
    case "revenueRange":
      return {
        text: formatRange(row.event.revenueLow, row.event.revenueHigh, formatCompact),
        color: selectedColor ?? colors.textDim,
      };
    case "revenueGrowth":
      return {
        text: row.event.revenueGrowth != null ? formatPercent(row.event.revenueGrowth) : "—",
        color: estimateColor(row.event.revenueGrowth, selectedColor),
      };
    case "analysts":
      return {
        text: formatAnalystSummary(row.event),
        color: selectedColor ?? colors.textDim,
      };
  }
}
