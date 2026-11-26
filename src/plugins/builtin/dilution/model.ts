import type {
  DilutionMetrics,
  DilutionRiskTier,
  OfferingType,
} from "../../../api-client/dilution";
import type { DataTableColumn } from "../../../components";
import { MISSING_VALUE, formatCompact, formatNumber } from "../../../utils/format";

export type DilutionTab = "overview" | "offerings" | "form144" | "scanner";

export const DILUTION_TABS: readonly { value: DilutionTab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "offerings", label: "Offerings" },
  { value: "form144", label: "Form 144" },
  { value: "scanner", label: "Scanner" },
];

export const DILUTION_TAB_IDS: readonly DilutionTab[] = [
  "overview",
  "offerings",
  "form144",
  "scanner",
];

export function fmtUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${formatNumber(abs / 1e9, 2)}B`;
  if (abs >= 1e6) return `${sign}$${formatNumber(abs / 1e6, 1)}M`;
  if (abs >= 1e3) return `${sign}$${formatNumber(abs / 1e3, 0)}K`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

export function fmtShares(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  return formatCompact(value);
}

export function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  return `${formatNumber(value, digits)}%`;
}

export function offeringTypeShort(type: OfferingType): string {
  switch (type) {
    case "atm": return "ATM";
    case "follow_on": return "Follow-On";
    case "registered_direct": return "Reg Direct";
    case "convertible": return "Convertible";
    case "secondary": return "Secondary";
    case "warrant": return "Warrants";
    case "hk_placement": return "HK Place";
    default: return "Prospectus";
  }
}

export function riskTierLabel(tier: DilutionRiskTier): string {
  switch (tier) {
    case "high": return "HIGH";
    case "elevated": return "ELEVATED";
    case "moderate": return "MODERATE";
    default: return "LOW";
  }
}

export function shelfCapacitySummary(metrics: DilutionMetrics): string {
  if (metrics.babyShelfRestricted && metrics.babyShelfCapUsd != null) {
    return `I.B.6 1/3 cap ${fmtUsd(metrics.babyShelfCapUsd)} · rem ${fmtUsd(metrics.babyShelfRemainingUsd)}`;
  }
  if (metrics.hasWksiShelf) {
    return metrics.atmCapacityUsd > 0
      ? `WKSI S-3ASR (uncapped) · ATM ${fmtUsd(metrics.atmCapacityUsd)}`
      : "WKSI S-3ASR (uncapped automatic shelf)";
  }
  if (metrics.registeredShelfUsd != null) {
    return `Cap ${fmtUsd(metrics.registeredShelfUsd)} · drawn 12m ${fmtUsd(metrics.drawnLast12mUsd)} · rem ${fmtUsd(metrics.remainingShelfHeadroomUsd)}`;
  }
  return "No active capped shelf registration";
}

/** Visual capacity bar using clean Unicode block glyphs for both TUI and desktop parity. */
export function buildCapacityBar(metrics: DilutionMetrics, barWidth = 28): string {
  const cap =
    metrics.babyShelfCapUsd ??
    metrics.registeredShelfUsd ??
    (metrics.atmCapacityUsd > 0 ? metrics.atmCapacityUsd : null);
  if (!cap || cap <= 0) return "";
  const drawn = Math.max(0, metrics.drawnLast12mUsd);
  const ratio = Math.min(1, drawn / cap);
  const filled = Math.round(ratio * barWidth);
  const empty = Math.max(0, barWidth - filled);
  return `${"█".repeat(filled)}${"░".repeat(empty)} ${Math.round(ratio * 100)}% drawn`;
}

export function shelfColumns(width: number): DataTableColumn[] {
  const cols: DataTableColumn[] = [
    { id: "form", label: "Form", width: 9, align: "left" },
    { id: "filed", label: "Filed", width: 11, align: "left" },
    { id: "expiry", label: "Rule 415 Exp", width: 14, align: "left" },
    { id: "cap", label: "Registered", width: 12, align: "right" },
    { id: "status", label: "Status", width: 11, align: "left" },
  ];
  if (width >= 90) {
    cols.push({ id: "securities", label: "Securities", width: Math.max(18, width - 64), align: "left" });
  }
  return cols;
}

export function offeringColumns(width: number): DataTableColumn[] {
  const cols: DataTableColumn[] = [
    { id: "filed", label: "Filed", width: 11, align: "left" },
    { id: "type", label: "Type", width: 12, align: "left" },
    { id: "form", label: "Form", width: 7, align: "left" },
    { id: "amount", label: "Amount $", width: 11, align: "right" },
    { id: "shares", label: "Shares", width: 10, align: "right" },
  ];
  if (width >= 76) {
    cols.push({ id: "agent", label: "Sales Agent / Lead", width: Math.max(18, width - 58), align: "left" });
  }
  return cols;
}

export function form144Columns(width: number, includeSymbol: boolean): DataTableColumn[] {
  const cols: DataTableColumn[] = [
    { id: "filed", label: "Filed", width: 11, align: "left" },
    ...(includeSymbol ? [{ id: "symbol", label: "Ticker", width: 8, align: "left" as const }] : []),
    { id: "seller", label: "Insider", width: width >= 96 ? 22 : 16, align: "left" },
    { id: "shares", label: "Shares", width: 10, align: "right" },
    { id: "value", label: "Est. Value", width: 11, align: "right" },
  ];
  if (width >= 84) {
    cols.push({ id: "plan", label: "10b5-1", width: 12, align: "left" });
  }
  if (width >= 104) {
    cols.push({ id: "broker", label: "Broker", width: Math.max(16, width - (includeSymbol ? 84 : 76)), align: "left" });
  }
  return cols;
}

export function scannerShelfColumns(width: number): DataTableColumn[] {
  const cols: DataTableColumn[] = [
    { id: "symbol", label: "Ticker", width: 8, align: "left" },
    { id: "company", label: "Issuer", width: width >= 96 ? 24 : 16, align: "left" },
    { id: "form", label: "Form", width: 8, align: "left" },
    { id: "cap", label: "Shelf Cap", width: 11, align: "right" },
    { id: "atm", label: "ATMs", width: 6, align: "right" },
    { id: "drawn", label: "12m Off.", width: 11, align: "right" },
  ];
  if (width >= 90) {
    cols.push({ id: "expiry", label: "Expiry", width: 12, align: "left" });
    cols.push({ id: "baby", label: "Rule", width: 11, align: "left" });
  }
  return cols;
}
