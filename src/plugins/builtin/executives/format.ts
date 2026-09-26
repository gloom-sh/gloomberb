import type { CloudExecutiveRowPayload } from "../../../api-client";
import { formatPercentRaw } from "../../../utils/format";

/** "$36.3M", "$282K", "$50,000". */
export function formatPay(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2).replace(/\.?0+$/, "")}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1e5) return `$${Math.round(value / 1e3)}K`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
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
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    // Filing and meeting dates are calendar labels, not local event times.
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

/** Share of a row's total that was stock and option awards, as "82%". */
export function equityShare(row: CloudExecutiveRowPayload): string {
  if (!row.total) return "";
  const equity = (row.stockAwards ?? 0) + (row.optionAwards ?? 0);
  if (equity <= 0) return "";
  return `${Math.round((equity / row.total) * 100)}%`;
}
