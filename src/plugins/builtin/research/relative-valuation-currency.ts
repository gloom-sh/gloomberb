import type { HeadlessPaneContext } from "../../../types/headless";
import { MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import { fxLegForCurrency } from "../../../market-data/coordinator/fx-legs";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { errorMessage } from "../../../utils/errors";

/** One currency's US dollar rate, as the app's FX rates serve it: USD per unit, and when it was observed. */
export interface UsdRate {
  rate: number;
  /** The source's observation time; null when it states none. */
  asOf: string | null;
  /** When the rate was read, said in place of an observation time the source does not state. */
  retrievedAt?: string | null;
}

/** A rate a market cap was converted at: `to` per `from`, and the older of its two legs' observation times. */
export interface CapConversion {
  from: string;
  to: string;
  rate: number;
  asOf: string | null;
  /** When the rate was read, for a rate whose source states no observation time. */
  retrievedAt: string | null;
}

type CapRow = { symbol: string; marketCap: number | null; marketCapCurrency: string | null };

export type ConvertedCapRow<Row extends CapRow> = Row & {
  /** The cap as the source served it, and its currency, when it was converted. */
  marketCapNative?: number;
  marketCapNativeCurrency?: string;
};

const usable = (rate: number | undefined): rate is number => rate != null && Number.isFinite(rate) && rate > 0;

function olderOf(left: string | null, right: string | null): string | null {
  if (!left || !right) return left ?? right;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

/**
 * Every row's market cap in `target`, through each currency's US dollar
 * rate (a pence cap is first made pounds). A row already in `target`, or
 * with no cap, stays as it is. A currency with no usable rate leaves its
 * rows in their own currency and is listed in `unconverted`, so the table
 * never mixes a guess in.
 */
export function convertMarketCaps<Row extends CapRow>(
  rows: readonly Row[],
  target: string,
  rates: ReadonlyMap<string, UsdRate>,
): { rows: Array<ConvertedCapRow<Row>>; conversions: CapConversion[]; unconverted: Array<{ currency: string; symbols: string[] }> } {
  const usd = (currency: string): UsdRate | undefined => (currency === "USD" ? { rate: 1, asOf: null } : rates.get(currency));
  const conversions = new Map<string, CapConversion>();
  const unconverted = new Map<string, string[]>();
  const converted = rows.map((row): ConvertedCapRow<Row> => {
    if (row.marketCap == null || !row.marketCapCurrency || row.marketCapCurrency === target) return row;
    const unit = resolveCurrencyUnit(row.marketCapCurrency);
    let rate = 1;
    if (unit.currency !== target) {
      const from = usd(unit.currency);
      const to = usd(target);
      if (!from || !to || !usable(from.rate) || !usable(to.rate)) {
        unconverted.set(row.marketCapCurrency, [...unconverted.get(row.marketCapCurrency) ?? [], row.symbol]);
        return row;
      }
      rate = from.rate / to.rate;
      if (!conversions.has(unit.currency)) {
        conversions.set(unit.currency, {
          from: unit.currency, to: target, rate, asOf: olderOf(from.asOf, to.asOf), retrievedAt: olderOf(from.retrievedAt ?? null, to.retrievedAt ?? null),
        });
      }
    }
    return {
      ...row,
      marketCap: row.marketCap / unit.divisor * rate,
      marketCapCurrency: target,
      marketCapNative: row.marketCap,
      marketCapNativeCurrency: row.marketCapCurrency,
    };
  });
  return {
    rows: converted,
    conversions: [...conversions.values()],
    unconverted: [...unconverted].map(([currency, symbols]) => ({ currency, symbols })),
  };
}

/** A rate as a dealer quotes it: `EUR/USD 1.1612`, `USD/JPY 151.20`; a cross of two other currencies as `from/to`. */
export function conversionPairText({ from, to, rate }: Pick<CapConversion, "from" | "to" | "rate">): string {
  const figure = (value: number) => value.toPrecision(5);
  if (from !== "USD" && to !== "USD") return `${from}/${to} ${figure(rate)}`;
  const other = to === "USD" ? from : to;
  const usdPerOther = to === "USD" ? rate : 1 / rate;
  const perDollar = fxLegForCurrency(other)?.invert ?? true;
  return perDollar ? `USD/${other} ${figure(1 / usdPerOther)}` : `${other}/USD ${figure(usdPerOther)}`;
}

/** `2026-10-13 21:00 UTC`, or `2026-10-13` for a date. */
function rateTimeText(asOf: string): string {
  const time = Date.parse(asOf);
  if (!Number.isFinite(time)) return asOf;
  return /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The status line's note naming each rate and its date:
 * `market caps in USD at EUR/USD 1.1612 (2026-10-13 21:00 UTC)`.
 */
export function conversionNote(target: string, conversions: readonly CapConversion[]): string | null {
  if (conversions.length === 0) return null;
  const rates = conversions.map((conversion) => `${conversionPairText(conversion)} (${conversion.asOf ? rateTimeText(conversion.asOf)
    : conversion.retrievedAt ? `retrieved ${rateTimeText(conversion.retrievedAt)}` : "time not stated"})`);
  return `market caps in ${target} at ${rates.join(", ")}`;
}

/**
 * The US dollar rate of each currency through the app's FX path (the market
 * data coordinator's `loadFxRate`, which converted totals read), a pence code
 * as its pound. A currency whose rate fails is listed in `failed` with why.
 */
export async function loadFxLegs(
  currencies: readonly string[],
  ctx: Pick<HeadlessPaneContext, "marketData">,
): Promise<{ legs: Map<string, UsdRate>; failed: Array<{ currency: string; reason: string }> }> {
  const wanted = [...new Set(currencies.map((currency) => resolveCurrencyUnit(currency).currency).filter((currency) => currency && currency !== "USD"))];
  const legs = new Map<string, UsdRate>();
  const failed: Array<{ currency: string; reason: string }> = [];
  if (wanted.length === 0) return { legs, failed };
  const coordinator = new MarketDataCoordinator(ctx.marketData);
  try {
    await Promise.all(wanted.map(async (currency) => {
      try {
        const entry = await coordinator.loadFxRate(currency);
        const rate = resolveEntryValue(entry);
        if (!usable(rate ?? undefined)) throw new Error(entry.error?.message ?? "no usable rate");
        const time = (value: number | null | undefined) => (value != null && Number.isFinite(value) ? new Date(value).toISOString() : null);
        legs.set(currency, { rate: rate!, asOf: time(entry.asOf), retrievedAt: time(entry.fetchedAt) });
      } catch (error) {
        failed.push({ currency, reason: errorMessage(error) });
      }
    }));
  } finally {
    coordinator.destroy();
  }
  return { legs, failed };
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** `--currency`: a three-letter code the runtime knows, upper-cased. */
export function normalizeCapCurrency(value: string): string {
  const code = value.trim().toUpperCase();
  let known: readonly string[] = [];
  try {
    known = Intl.supportedValuesOf("currency");
  } catch {
    // An older runtime lists none; the shape check stands alone.
  }
  if (!CURRENCY_CODE.test(code) || (known.length > 0 && !known.includes(code))) {
    throw new Error(`Invalid --currency value "${value}". Use a three-letter currency code such as USD or EUR.`);
  }
  return code;
}
