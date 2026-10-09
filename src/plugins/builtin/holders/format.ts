import type { HolderData, HolderRecord } from "../../../types/financials";
import { formatCompact, formatPercent, formatPercentRaw } from "../../../utils/format";
import type { HolderRow } from "./types";

export function formatMoneyCompact(value: number | undefined, currency = "USD"): string {
  if (value == null) return "-";
  if (currency === "USD") {
    const sign = value < 0 ? "-" : "";
    return `${sign}$${formatCompact(Math.abs(value))}`;
  }
  return `${formatCompact(value)} ${currency}`;
}

export function formatMaybePercent(value: number | undefined): string {
  if (value == null) return "-";
  return Math.abs(value) <= 1 ? formatPercent(value) : formatPercentRaw(value);
}

/**
 * The currency holder values are in. Gloom Cloud names it when it differs
 * from the listing's (dollars from 13F filings on a London line); an older
 * service priced them in the listing's currency.
 */
export function holderValueCurrency(
  data: Pick<HolderData, "valueCurrency" | "currency"> | null | undefined,
  fallback?: string,
): string | undefined {
  return data?.valueCurrency?.trim() || data?.currency?.trim() || fallback;
}

/**
 * The market cap a holding's value can be divided by: only one in the
 * values' own currency. A cap whose currency, or values whose currency, is
 * not known is taken as it was before currencies were stated.
 */
export function holderStakeMarketCap(
  marketCap: number | undefined,
  marketCapCurrency: string | null | undefined,
  valueCurrency: string | null | undefined,
): number | undefined {
  if (marketCap == null) return undefined;
  if (marketCapCurrency && valueCurrency && marketCapCurrency !== valueCurrency) return undefined;
  return marketCap;
}

/** The reported stake, else the value over a market cap `holderStakeMarketCap` allowed. */
export function resolveHolderOwnershipPercent(row: Pick<HolderRecord, "percentHeld" | "value">, marketCap: number | undefined): number | undefined {
  if (row.percentHeld != null) return row.percentHeld;
  if (row.value == null || row.value < 0 || marketCap == null || marketCap <= 0) return undefined;
  return row.value / marketCap;
}

/** A stake too small for two decimals reads "<0.01%", not a zero. */
export function formatHolderOwnershipPercent(value: number | undefined): string {
  if (value == null) return "-";
  const percent = Math.abs(value) <= 1 ? value * 100 : value;
  if (percent > 0 && percent < 0.005) return "<0.01%";
  return `${percent.toFixed(2)}%`;
}

export function formatHolderOwnershipLine(row: HolderRow, marketCap: number | undefined): string | null {
  const ownership = resolveHolderOwnershipPercent(row, marketCap);
  return ownership == null ? null : `${formatHolderOwnershipPercent(ownership)} held`;
}

export function formatSignedCompact(value: number | undefined): string {
  if (value == null) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatCompact(value)}`;
}

export function displayDate(value: string | undefined): string {
  return value?.slice(0, 10) ?? "-";
}
