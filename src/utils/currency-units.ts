
const SUB_UNIT_CURRENCIES: Record<string, { currency: string; divisor: number }> = {
  GBp: { currency: "GBP", divisor: 100 },
  GBX: { currency: "GBP", divisor: 100 },
  ILA: { currency: "ILS", divisor: 100 },
  ZAc: { currency: "ZAR", divisor: 100 },
};

const SUB_UNIT_NAMES: Record<string, string> = {
  GBp: "pence",
  GBX: "pence",
  ILA: "agorot",
  ZAc: "cents",
};

/** A currency code as a reader should see it; a sub-unit says which one: "GBp (pence)". */
export function currencyUnitLabel(code?: string | null): string {
  const raw = (code ?? "").trim();
  const unit = SUB_UNIT_NAMES[raw];
  return unit ? `${raw} (${unit})` : raw;
}

const LIKELY_UNIT_MISMATCH_RATIOS: Record<string, number[]> = {
  BHD: [1000],
  GBP: [100],
  ILS: [100],
  JOD: [1000],
  KWD: [1000],
  OMR: [1000],
  TND: [1000],
  ZAR: [100],
};

const SUB_UNIT_EXCHANGE_RULES = [
  { exchanges: new Set(["LSE"]), currency: "GBP", divisor: 100 },
  { exchanges: new Set(["TASE"]), currency: "ILS", divisor: 100 },
  { exchanges: new Set(["JSE"]), currency: "ZAR", divisor: 100 },
] as const;

export interface CurrencyUnitInfo {
  currency: string;
  divisor: number;
}

interface ExchangeSubUnitOptions {
  allowDefaultCurrency?: boolean;
  allowMissingCurrency?: boolean;
  defaultCurrency?: string;
}

function normalizeExchange(value?: string | null): string {
  return (value ?? "").trim().toUpperCase();
}

export function resolveCurrencyUnit(currency?: string | null): CurrencyUnitInfo {
  const raw = (currency ?? "").trim();
  if (!raw) {
    return { currency: "", divisor: 1 };
  }

  const normalized = SUB_UNIT_CURRENCIES[raw];
  if (normalized) {
    return normalized;
  }

  return {
    currency: raw.toUpperCase(),
    divisor: 1,
  };
}

export function resolveExchangeSubUnitCurrencyUnit(
  currency?: string | null,
  exchanges: Array<string | null | undefined> = [],
  options: ExchangeSubUnitOptions = {},
): CurrencyUnitInfo {
  const unit = resolveCurrencyUnit(currency);
  if (unit.divisor !== 1) return unit;

  const normalizedExchanges = new Set(exchanges.map((exchange) => normalizeExchange(exchange)).filter(Boolean));
  if (normalizedExchanges.size === 0) return unit;

  const defaultCurrency = (options.defaultCurrency ?? "USD").trim().toUpperCase();
  for (const rule of SUB_UNIT_EXCHANGE_RULES) {
    const matchesCurrency = unit.currency === rule.currency
      || (options.allowMissingCurrency === true && !unit.currency)
      || (options.allowDefaultCurrency === true && unit.currency === defaultCurrency);
    if (!matchesCurrency) continue;

    const matchesExchange = [...normalizedExchanges].some((exchange) => rule.exchanges.has(exchange));
    if (matchesExchange) {
      return {
        currency: unit.currency === rule.currency ? unit.currency : rule.currency,
        divisor: rule.divisor,
      };
    }
  }

  return unit;
}

export function resolvePriceHistoryCurrencyUnit(
  currency?: string | null,
  exchange?: string | null,
): CurrencyUnitInfo {
  return resolveExchangeSubUnitCurrencyUnit(currency, [exchange], {
    allowDefaultCurrency: true,
    allowMissingCurrency: true,
  });
}

export function normalizePriceValueByDivisor(value: number | undefined, divisor: number): number | undefined {
  if (value == null || !Number.isFinite(value) || divisor === 1) return value;
  return value / divisor;
}

function normalizedRatio(left: number, right: number): number {
  const ratio = left / right;
  return ratio >= 1 ? ratio : 1 / ratio;
}

function isRatioWithin(ratio: number, target: number, tolerance = 0.05): boolean {
  return Math.abs(ratio - target) / target < tolerance;
}

function likelyUnitMismatchRatios(currency: string): number[] {
  return LIKELY_UNIT_MISMATCH_RATIOS[currency] ?? [100];
}

export function hasLikelyQuoteUnitMismatch(
  left: { currency?: string; price: number } | null | undefined,
  right: { currency?: string; price: number } | null | undefined,
): boolean {
  if (!left || !right) return false;

  const leftUnit = resolveCurrencyUnit(left.currency);
  const rightUnit = resolveCurrencyUnit(right.currency);
  if (!leftUnit.currency || !rightUnit.currency) return false;
  if (leftUnit.currency !== rightUnit.currency) return false;
  if (!Number.isFinite(left.price) || !Number.isFinite(right.price)) return false;
  if (left.price <= 0 || right.price <= 0) return false;

  if (leftUnit.divisor !== rightUnit.divisor) {
    const leftCanonicalPrice = left.price / leftUnit.divisor;
    const rightCanonicalPrice = right.price / rightUnit.divisor;
    if (isRatioWithin(normalizedRatio(leftCanonicalPrice, rightCanonicalPrice), 1)) {
      return true;
    }
  }

  const ratio = normalizedRatio(left.price, right.price);
  return likelyUnitMismatchRatios(leftUnit.currency).some((target) => isRatioWithin(ratio, target));
}
