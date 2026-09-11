import type { TimeSeriesPoint } from "./types";

/** Statement currency is independent of the currency in which a share trades. */
export function reportingCurrencySeries(points: readonly TimeSeriesPoint[], fallbackCurrency?: string) {
  const declared = fallbackCurrency?.trim() || undefined;
  const explicit = new Set(points.flatMap((point) => point.provenance?.currency?.trim() ? [point.provenance.currency.trim()] : []));
  // A current aggregate cannot fill historical currency gaps when the rows
  // themselves establish a currency change or contradict that aggregate.
  const fallback = explicit.size === 0 || (explicit.size === 1 && declared && explicit.has(declared)) ? declared : undefined;
  const withCurrency = points.map((point) => ({
    ...point,
    provenance: { ...point.provenance, currency: point.provenance?.currency?.trim() || fallback },
  }));
  const latest = [...withCurrency].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
    .find((point) => point.provenance.currency);
  const currency = latest?.provenance.currency;
  if (!currency) return {
    points: withCurrency,
    currency: undefined,
    warning: points.length ? "Reporting currency is unavailable for these monetary observations." : undefined,
  };
  const excluded = withCurrency.some((point) => point.provenance.currency !== currency);
  return {
    currency,
    // A gap preserves the fiscal date and source currency without calculating a
    // return or study across monetary values in different units.
    points: withCurrency.map((point) => point.provenance.currency === currency
      ? point : { ...point, value: null, rawValue: null }),
    warning: excluded
      ? `Only ${currency} reporting-currency observations are shown; other or unspecified currencies are unavailable. No FX conversion is applied.`
      : undefined,
  };
}
