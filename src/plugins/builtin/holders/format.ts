import type { HolderData, HolderRecord } from "../../../types/financials";
import { formatCompact, MISSING_VALUE } from "../../../utils/format";
import type { HolderRow } from "./types";

export function formatMoneyCompact(value: number | undefined, currency = "USD"): string {
  if (value == null) return MISSING_VALUE;
  if (currency === "USD") {
    const sign = value < 0 ? "-" : "";
    return `${sign}$${formatCompact(Math.abs(value))}`;
  }
  return `${formatCompact(value)} ${currency}`;
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

/**
 * A holder's stake or quarter's change in percent, as the reports carry it.
 * Every holder record gives both as a fraction: 0.0059 is a 0.59% stake,
 * 1.086 a position that grew 108.6%, -0.6 one that fell 60%. Six significant
 * digits drop a source's float noise.
 */
export function holderPercent(fraction: number | null | undefined): number | null {
  if (fraction == null || !Number.isFinite(fraction)) return null;
  return Number((fraction * 100).toPrecision(6));
}

/** A stake in percent too small for two decimals reads "<0.01%", not a zero. */
export function formatPercentHeld(percent: number | null | undefined): string {
  if (percent == null) return MISSING_VALUE;
  if (percent > 0 && percent < 0.005) return "<0.01%";
  return `${percent.toFixed(2)}%`;
}

/**
 * A change in percent, signed, to two decimals; from 1000% on to none, so a
 * position that grew tenfold still fits its column.
 */
export function formatChangePercent(percent: number | null | undefined): string {
  if (percent == null || !Number.isFinite(percent)) return MISSING_VALUE;
  const fixed = Math.abs(percent).toFixed(Math.abs(percent) >= 1000 ? 0 : 2);
  if (!/[1-9]/.test(fixed)) return `${fixed}%`;
  return `${percent > 0 ? "+" : "-"}${fixed}%`;
}

/** A holder record's quarter's change, a fraction, as the pane shows it. */
export function formatHolderChangePercent(fraction: number | null | undefined): string {
  return formatChangePercent(holderPercent(fraction));
}

/** A stake too small for two decimals reads "<0.01%", not a zero. */
export function formatHolderOwnershipPercent(value: number | undefined): string {
  return formatPercentHeld(holderPercent(value));
}

export function formatHolderOwnershipLine(row: HolderRow, marketCap: number | undefined): string | null {
  const ownership = resolveHolderOwnershipPercent(row, marketCap);
  return ownership == null ? null : `${formatHolderOwnershipPercent(ownership)} held`;
}

export function formatSignedCompact(value: number | undefined): string {
  if (value == null) return MISSING_VALUE;
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatCompact(value)}`;
}

export function displayDate(value: string | undefined): string {
  return value?.slice(0, 10) ?? MISSING_VALUE;
}
