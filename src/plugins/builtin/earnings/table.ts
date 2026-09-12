import { TextAttributes } from "../../../ui";
import type { DataTableCell, DataTableColumn } from "../../../components";
import type { EarningsEstimateField, EarningsEvent } from "../../../types/data-provider";
import { colors } from "../../../theme/colors";
import { formatCompact, formatNumber, formatPercent } from "../../../utils/format";
import type { EarningsDisplayRow } from "./model";
import { coherentEarningsValue, earningsEpsChange30d, earningsForecastPeriod } from "./estimate-basis";

type EarningsColumnId =
  | "date"
  | "when"
  | "status"
  | "symbol"
  | "name"
  | "forecastEnd"
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

function formatEstimate(event: EarningsEvent, field: EarningsEstimateField, formatter: (value: number) => string): string {
  const value = coherentEarningsValue(event, field);
  return value == null ? "—" : `${event.estimateBasis?.[field]?.currency ?? "?"} ${formatter(value)}`;
}

function formatEstimateRange(
  event: EarningsEvent, lowField: EarningsEstimateField, highField: EarningsEstimateField,
  formatter: (value: number) => string,
): string {
  const low = coherentEarningsValue(event, lowField);
  const high = coherentEarningsValue(event, highField);
  if (low == null && high == null) return "—";
  const lowCurrency = event.estimateBasis?.[lowField]?.currency ?? "?";
  const highCurrency = event.estimateBasis?.[highField]?.currency ?? "?";
  if (lowCurrency === highCurrency) return `${lowCurrency} ${low == null ? "—" : formatter(low)}-${high == null ? "—" : formatter(high)}`;
  return `${formatEstimate(event, lowField, formatter)}-${formatEstimate(event, highField, formatter)}`;
}

function formatRevisionSummary(event: EarningsEvent): string {
  const up = coherentEarningsValue(event, "epsRevisionUp30d");
  const down = coherentEarningsValue(event, "epsRevisionDown30d");
  if (up == null && down == null) return "—";
  return `${up ?? "—"}/${down ?? "—"}`;
}

function formatAnalystSummary(event: EarningsEvent): string {
  const eps = coherentEarningsValue(event, "epsAnalysts");
  const revenue = coherentEarningsValue(event, "revenueAnalysts");
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
  const epsWidth = 11;
  const forecastEndWidth = 10;
  const epsRangeWidth = 20;
  const growthWidth = 8;
  const trendWidth = 11;
  const revisionsWidth = 7;
  const revenueWidth = 12;
  const revenueRangeWidth = 23;
  const analystsWidth = 7;
  const columnCount = 15;
  const fixedWidth = dateWidth + whenWidth + statusWidth + symbolWidth + epsWidth + forecastEndWidth
    + epsRangeWidth + growthWidth + trendWidth + revisionsWidth + revenueWidth
    + revenueRangeWidth + growthWidth + analystsWidth;
  const nameWidth = Math.max(14, width - 2 - columnCount - fixedWidth);

  return [
    { id: "date", label: "DATE", width: dateWidth, align: "left" },
    { id: "when", label: "WHEN", width: whenWidth, align: "left" },
    { id: "status", label: "ST", width: statusWidth, align: "left" },
    { id: "symbol", label: "TICKER", width: symbolWidth, align: "left" },
    { id: "name", label: "NAME", width: nameWidth, align: "left" },
    { id: "forecastEnd", label: "EST END", width: forecastEndWidth, align: "left" },
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
    case "forecastEnd":
      return { text: earningsForecastPeriod(row.event)?.periodEndDate ?? "—", color: selectedColor ?? colors.textDim };
    case "epsEstimate":
      return {
        text: formatEstimate(row.event, "epsEstimate", value => formatNumber(value, 2)),
        color: selectedColor ?? colors.textDim,
      };
    case "epsRange":
      return {
        text: formatEstimateRange(row.event, "epsLow", "epsHigh", value => formatNumber(value, 2)),
        color: selectedColor ?? colors.textDim,
      };
    case "epsGrowth":
      return {
        text: coherentEarningsValue(row.event, "epsGrowth") != null ? formatPercent(coherentEarningsValue(row.event, "epsGrowth")!) : "—",
        color: estimateColor(coherentEarningsValue(row.event, "epsGrowth"), selectedColor),
      };
    case "epsTrend": {
      const change = earningsEpsChange30d(row.event);
      return {
        text: change != null ? `${row.event.estimateBasis?.epsEstimate?.currency} ${formatNumber(change, 2)}` : "—",
        color: estimateColor(change, selectedColor),
      };
    }
    case "epsRevisions": {
      const up = coherentEarningsValue(row.event, "epsRevisionUp30d");
      const down = coherentEarningsValue(row.event, "epsRevisionDown30d");
      const net = up != null && down != null ? up - down : null;
      return {
        text: formatRevisionSummary(row.event),
        color: selectedColor ?? (net != null && net > 0 ? colors.positive : net != null && net < 0 ? colors.negative : colors.textDim),
      };
    }
    case "revenueEstimate":
      return {
        text: formatEstimate(row.event, "revenueEstimate", formatCompact),
        color: selectedColor ?? colors.textDim,
      };
    case "revenueRange":
      return {
        text: formatEstimateRange(row.event, "revenueLow", "revenueHigh", formatCompact),
        color: selectedColor ?? colors.textDim,
      };
    case "revenueGrowth":
      return {
        text: coherentEarningsValue(row.event, "revenueGrowth") != null ? formatPercent(coherentEarningsValue(row.event, "revenueGrowth")!) : "—",
        color: estimateColor(coherentEarningsValue(row.event, "revenueGrowth"), selectedColor),
      };
    case "analysts":
      return {
        text: formatAnalystSummary(row.event),
        color: selectedColor ?? colors.textDim,
      };
  }
}
