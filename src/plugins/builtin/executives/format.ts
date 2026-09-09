import type { CloudExecutiveRowPayload } from "../../../api-client";

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

/** "+17%" or "-27%"; empty when either year is missing. */
export function formatChange(
  current: number | null,
  prior: number | null,
): string {
  if (!current || !prior || prior <= 0) return "";
  const change = Math.round(((current - prior) / prior) * 100);
  return `${change > 0 ? "+" : ""}${change}%`;
}

export function formatFiled(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
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

/** "President and CEO" trimmed to fit a column. */
export function shortTitle(title: string, max: number): string {
  const cleaned = title.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
