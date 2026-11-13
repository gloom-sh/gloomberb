import type { CloudExecutiveRowPayload } from "../../../api-client";
import { formatShortDate } from "../../../utils/datetime-format";
import { MISSING_VALUE, formatPercentRaw } from "../../../utils/format";

/** "$36.3M", "$282K", "$50,000"; a table column keeps the decimals (`fixedDecimals`), so $12.0M lines up under $36.3M. */
export function formatPay(value: number | null | undefined, { fixedDecimals = false }: { fixedDecimals?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return MISSING_VALUE;
  const abs = Math.abs(value);
  const trim = (text: string, zeros: RegExp) => fixedDecimals ? text : text.replace(zeros, "");
  if (abs >= 1e9) return `$${trim((value / 1e9).toFixed(2), /\.?0+$/)}B`;
  if (abs >= 1e6) return `$${trim((value / 1e6).toFixed(1), /\.0$/)}M`;
  if (abs >= 1e5) return `$${Math.round(value / 1e3)}K`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined) return MISSING_VALUE;
  return `${Math.round(value)}:1`;
}

/** Preserve the direction of small changes; empty without a valid comparison. */
export function formatChange(
  current: number | null | undefined,
  prior: number | null | undefined,
): string {
  if (current == null || prior == null || !Number.isFinite(current) || !Number.isFinite(prior) || prior <= 0) return "";
  const change = ((current - prior) / prior) * 100;
  if (!Number.isFinite(change)) return "";
  if (change !== 0 && Math.abs(change) < 0.01) return `${change > 0 ? "+" : "-"}<0.01%`;
  return formatPercentRaw(change).replace(/\.00%$/, "%");
}

export function formatFiled(value: string | null): string {
  // Filing and meeting dates are calendar labels, not local event times.
  return formatShortDate(value, { day: "2-digit", utc: true, fallback: MISSING_VALUE });
}

/** Share of a row's total that was stock and option awards, as "82%". */
export function equityShare(row: CloudExecutiveRowPayload): string {
  if (!row.total) return "";
  const equity = (row.stockAwards ?? 0) + (row.optionAwards ?? 0);
  if (equity <= 0) return "";
  return `${Math.round((equity / row.total) * 100)}%`;
}
