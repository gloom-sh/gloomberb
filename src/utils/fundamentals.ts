import { formatFxRate } from "../cli/fx-pair";
import type { EnterpriseValueCheck, Fundamentals, Quote, TickerFinancials } from "../types/financials";
import { quotedFxPair } from "./currency-pair";
import { resolveCurrencyUnit } from "./currency-units";
import { formatCompact } from "./format";
import { formatUtcTime } from "./utc-time";

export const RETRACTABLE_VALUATION_FIELDS = ["enterpriseValue", "enterpriseToRevenue"] as const;

/** A retraction survives serialization and overrides a contradictory cached number. */
export function redactUnavailableFundamentals(value: Fundamentals | undefined): Fundamentals | undefined {
  if (!value || value.unavailableFields === undefined) return value;
  const unavailableFields = Array.isArray(value.unavailableFields)
    ? RETRACTABLE_VALUATION_FIELDS.filter((field) => value.unavailableFields!.includes(field)) : [];
  const result = { ...value };
  if (unavailableFields.length) result.unavailableFields = unavailableFields;
  else delete result.unavailableFields;
  for (const field of unavailableFields) delete result[field];
  return result;
}

/** A source's enterprise value, or undefined when it has none: banks and insurers come back as 0, which is a gap, not a value. */
export function reportedEnterpriseValue(fundamentals: Pick<Fundamentals, "enterpriseValue"> | undefined): number | undefined {
  const value = fundamentals?.enterpriseValue;
  return typeof value === "number" && Number.isFinite(value) && value !== 0 ? value : undefined;
}

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The served check of the enterprise value beside it, when it describes that value: a provider EV the check labels or
 * matches is the one shown, a computed one is the check's own figure, and a withdrawn or not meaningful one is no
 * longer shown. A check merged beside another source's EV is none.
 */
export function enterpriseValueCheck(
  fundamentals: Pick<Fundamentals, "enterpriseValue" | "enterpriseValueCheck" | "unavailableFields"> | undefined,
): EnterpriseValueCheck | undefined {
  const check = fundamentals?.enterpriseValueCheck;
  if (!check) return undefined;
  const withdrawn = fundamentals?.enterpriseValue === undefined && !!fundamentals?.unavailableFields?.includes("enterpriseValue");
  // Not meaningful needs no figure of its own: a source EV below zero may come with no cap or currency.
  if (check.status === "not-meaningful") return withdrawn ? check : undefined;
  if (!check.currency) return undefined;
  if (check.status === "withdrawn") return withdrawn && finiteNumber(check.computed) && finiteNumber(check.source) ? check : undefined;
  if (check.status === "computed") {
    return finiteNumber(check.computed) && fundamentals?.enterpriseValue === check.computed ? check : undefined;
  }
  return finiteNumber(check.source) && fundamentals?.enterpriseValue === check.source ? check : undefined;
}

/** Why a source EV below zero that nothing checked is not meaningful: its cash and investments exceed the rest. */
const SOURCE_ENTERPRISE_VALUE_NOT_POSITIVE = "Cash and investments exceed market cap + debt in the source's EV";

/**
 * Why the enterprise value is not meaningful, if it is: Gloom Cloud's reason for an EV that comes out at or below
 * zero, or for an EV below zero from any source that served no check. A bank's 0 is a gap, not N/M. EV/S, EV/EBITDA
 * and a reverse DCF over it are N/M too.
 */
export function enterpriseValueNotMeaningful(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): string | undefined {
  const check = enterpriseValueCheck(fundamentals);
  if (check?.status === "not-meaningful") return check.reason?.trim() || SOURCE_ENTERPRISE_VALUE_NOT_POSITIVE;
  const value = fundamentals?.enterpriseValue;
  return finiteNumber(value) && value < 0 ? SOURCE_ENTERPRISE_VALUE_NOT_POSITIVE : undefined;
}

/**
 * Whether the provider's EV was withdrawn: retracted (`unavailableFields`) and none served in its place, by the
 * served check or by Gloom Cloud's own validation of the source observation, which leaves no check. Not one that is
 * not meaningful (enterpriseValueNotMeaningful), which says N/M instead.
 */
export function enterpriseValueWithdrawn(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): boolean {
  return fundamentals?.enterpriseValue === undefined && !!fundamentals?.unavailableFields?.includes("enterpriseValue")
    && enterpriseValueNotMeaningful(fundamentals) === undefined;
}

/** "(provider)" beside an EV more than 5% from market cap + debt - cash, "unavailable" for a withdrawn one, N/M for one at or below zero. */
export function enterpriseValueLabel(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): "provider" | "unavailable" | "not-meaningful" | undefined {
  if (enterpriseValueNotMeaningful(fundamentals)) return "not-meaningful";
  const status = enterpriseValueCheck(fundamentals)?.status;
  return status === "differs" ? "provider" : status === "withdrawn" || enterpriseValueWithdrawn(fundamentals) ? "unavailable" : undefined;
}

/**
 * The reconciliation line under a labelled, withdrawn or not meaningful EV: "EV 61.75B USD (provider) vs 63.75B
 * computed from market cap + total debt - cash (balance sheet 2026-06-30).", "EV N/M: cash and short-term investments
 * exceed market cap + total debt (balance sheet 2026-06-30)." For an EV withdrawn without a check, that the source
 * failed validation. Undefined when the EV matches, is unchecked or computed, or has no check. Read it from the
 * fundamentals the rows show (atRegularSessionPrice moves the check with the EV and the market cap), so its figures
 * are theirs.
 */
export function enterpriseValueReconciliationNote(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): string | undefined {
  const notMeaningful = enterpriseValueNotMeaningful(fundamentals);
  if (notMeaningful) return `EV N/M: ${notMeaningful.charAt(0).toLowerCase()}${notMeaningful.slice(1)}.`;
  const check = enterpriseValueCheck(fundamentals);
  if (!check && enterpriseValueWithdrawn(fundamentals)) return "EV unavailable: the provider's figure failed validation.";
  if (!check || !finiteNumber(check.computed) || !finiteNumber(check.source)
    || (check.status !== "differs" && check.status !== "withdrawn")) return undefined;
  const source = `${formatCompact(check.source)} ${check.currency}`;
  const computed = formatCompact(check.computed);
  const basis = `market cap + total debt - cash${check.balanceSheetDate ? ` (balance sheet ${check.balanceSheetDate})` : ""}`;
  if (check.status === "differs") return `EV ${source} (provider) vs ${computed} computed from ${basis}.`;
  const ratio = check.computed > 0 ? ` is ${(check.source / check.computed).toFixed(1)}x` : " is far from";
  return `EV unavailable: the provider's ${source}${ratio} the ${computed} computed from ${basis}.`;
}

/**
 * What `valuation` says of an insurer's or a holding company's EV, which Gloom Cloud computes rather than takes from
 * the provider: "EV 1.23T USD is market cap + total debt - 40.61B of cash and equivalents (balance sheet 2026-06-30);
 * investments stay in." Undefined for any other EV. The overview stat says it in two words ("investments in").
 */
export function computedEnterpriseValueNote(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): string | undefined {
  const check = enterpriseValueCheck(fundamentals);
  if (check?.status !== "computed" || !finiteNumber(check.computed) || !finiteNumber(check.cash)) return undefined;
  const sheet = check.balanceSheetDate ? ` (balance sheet ${check.balanceSheetDate})` : "";
  return `EV ${formatCompact(check.computed)} ${check.currency} is market cap + total debt - ${formatCompact(check.cash)} of cash and equivalents${sheet}; investments stay in.`;
}

/** What names the currency of the trailing figures: the fundamentals' own labels, else the statements' on a listing that trades in theirs. */
type FundamentalsCurrencies = Pick<TickerFinancials, "financialCurrency"> & {
  fundamentals?: Pick<Fundamentals, "financialCurrency" | "epsCurrency" | "marketCapCurrency"> | null;
  quote?: Pick<Quote, "currency"> | null;
};

/**
 * The currency of the trailing EPS, revenue, income and cash flows: the one the fundamentals declare for themselves.
 * A block that declares none is in the statements' currency only when the listing trades in it; on a listing quoted
 * in another (a receipt in USD beside TWD books, YPFD in ARS beside USD statements) its currency is unknown, since
 * Gloom Cloud labels every block whose currency it can tell. Never the quote's.
 */
export function fundamentalsCurrency(
  financials: FundamentalsCurrencies | null | undefined,
): string | undefined {
  const declared = financials?.fundamentals?.financialCurrency?.trim();
  if (declared) return declared;
  const statements = financials?.financialCurrency?.trim();
  if (!statements) return undefined;
  const listed = financials?.fundamentals?.marketCapCurrency?.trim() || financials?.quote?.currency?.trim();
  return !listed || resolveCurrencyUnit(listed).currency === resolveCurrencyUnit(statements).currency ? statements : undefined;
}

/**
 * The currency of the trailing EPS: the one stated for it when it differs from the block's amounts (an EPS converted
 * to the listing's currency beside revenue left in the reporting one), else the block's.
 */
export function fundamentalsEpsCurrency(
  financials: FundamentalsCurrencies | null | undefined,
): string | undefined {
  return financials?.fundamentals?.epsCurrency?.trim() || fundamentalsCurrency(financials);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const usableRate = (rate: number | null | undefined): rate is number => typeof rate === "number" && Number.isFinite(rate) && rate > 0;

/** The currency a trailing block was converted from into another it is labelled with; undefined for a block in the reporting currency. */
function ttmConvertedFrom(fundamentals: Pick<Fundamentals, "financialCurrency" | "ttmConversion"> | undefined): string | undefined {
  const from = fundamentals?.ttmConversion?.from?.trim();
  const to = fundamentals?.financialCurrency?.trim();
  return from && to && from !== to ? from : undefined;
}

/** A rate the app converts at, the one `fx` reports: units of the target currency per unit of the source one, and when it was observed. */
export interface AppFxRate {
  rate: number;
  /** Epoch ms of the older leg's observation; null when the source did not date it. */
  asOf: number | null;
}

/** One currency's US dollar rate as the app holds it, a minor unit's by its major currency. */
type UsdLeg = (currency: string) => AppFxRate | null | undefined;

/**
 * The app's rate for a converted trailing block: units of its currency per unit of the one it was converted from,
 * through the two US dollar legs `fx` reads, dated by the older. Null for an unconverted block or a missing leg.
 */
export function appTtmRate(fundamentals: Pick<Fundamentals, "financialCurrency" | "ttmConversion"> | undefined, usd: UsdLeg): AppFxRate | null {
  const from = ttmConvertedFrom(fundamentals);
  if (!from || !usableRate(fundamentals?.ttmConversion?.rate)) return null;
  const leg = (currency: string) => {
    const major = resolveCurrencyUnit(currency).currency;
    return major === "USD" ? { rate: 1, asOf: null } : usd(major);
  };
  const source = leg(from), target = leg(fundamentals!.financialCurrency!.trim());
  if (!usableRate(source?.rate) || !usableRate(target?.rate)) return null;
  const dates = [source!.asOf, target!.asOf].filter((time): time is number => time != null && Number.isFinite(time));
  return { rate: source!.rate / target!.rate, asOf: dates.length > 0 ? Math.min(...dates) : null };
}

const TTM_AMOUNTS = ["revenue", "netIncome", "operatingCashFlow", "freeCashFlow"] as const;

/**
 * A converted trailing block at the app's own rate, so a screen converts at one rate, the one `fx` reports: revenue,
 * income and cash flows the source converted at `ttmConversion.rate` go back to the reporting currency and are
 * converted again at `rate`, which the conversion then names with its time. EPS stays at report-date rates. The block
 * as served when it is not converted, states no rate, or the app has none.
 */
export function ttmAtAppRate<T extends Fundamentals>(fundamentals: T, rate: AppFxRate | null | undefined): T {
  const conversion = fundamentals.ttmConversion;
  if (!rate || !usableRate(rate.rate) || !conversion || !ttmConvertedFrom(fundamentals) || !usableRate(conversion.rate)) return fundamentals;
  const factor = rate.rate / conversion.rate;
  const shown: T = { ...fundamentals };
  for (const key of TTM_AMOUNTS) {
    const value = fundamentals[key];
    if (finiteNumber(value)) (shown as Fundamentals)[key] = Math.round(value * factor);
  }
  const { asOf: _served, ...kept } = conversion;
  shown.ttmConversion = { ...kept, rate: rate.rate, ...(rate.asOf != null ? { asOf: new Date(rate.asOf).toISOString() } : {}) };
  return shown;
}

/** `2026-10-09`, or `2026-10-23 21:29 UTC` for the time of a rate. */
function conversionTime(asOf: string | undefined): string | undefined {
  if (!asOf) return undefined;
  if (ISO_DAY.test(asOf)) return asOf;
  const time = Date.parse(asOf);
  return Number.isFinite(time) ? formatUtcTime(new Date(time)) || undefined : undefined;
}

/**
 * "TTM converted from ARS at USD/ARS 1529, as of 2026-10-23 21:29 UTC; EPS at report-date rates.": what a converted
 * trailing block was converted from, at which rate, as markets quote the pair and `fx` reads it, and when. Undefined
 * for a block in the currency the company reports in.
 */
export function ttmConversionNote(fundamentals: Pick<Fundamentals, "financialCurrency" | "ttmConversion"> | undefined): string | undefined {
  const from = ttmConvertedFrom(fundamentals);
  if (!from) return undefined;
  const conversion = fundamentals!.ttmConversion!;
  const quoted = usableRate(conversion.rate) ? quotedFxPair(from, fundamentals!.financialCurrency!, conversion.rate) : undefined;
  const rate = quoted ? ` at ${quoted.pair} ${formatFxRate(quoted.rate)}` : "";
  const time = conversionTime(conversion.asOf);
  const when = time ? `${rate ? "," : ""} as of ${time}` : "";
  const eps = conversion.eps === "report_date" ? "; EPS at report-date rates" : "";
  return `TTM converted from ${from}${rate}${when}${eps}.`;
}

/**
 * "EPS (TTM) in USD, converted from CLP at report-date rates.": an EPS in another currency than the trailing amounts
 * beside it. Undefined when they share one.
 */
export function epsConversionNote(fundamentals: Pick<Fundamentals, "financialCurrency" | "epsCurrency"> | undefined): string | undefined {
  const eps = fundamentals?.epsCurrency?.trim();
  const amounts = fundamentals?.financialCurrency?.trim();
  return eps && amounts && eps !== amounts ? `EPS (TTM) in ${eps}, converted from ${amounts} at report-date rates.` : undefined;
}

/** What a trailing EPS that is not the filed quarters' is called where it is shown (EE's TTM row). */
export const SERVED_TRAILING_EPS = "Gloom Cloud's TTM";

/**
 * "EPS (TTM) and P/E (TTM) are Gloom Cloud's trailing figures, not the last four filed quarters'.": the headline EPS
 * is the filed quarters' (time-series/filed-trailing-eps), so one that is not says so. Undefined otherwise.
 */
export function trailingEpsSourceNote(fundamentals: Pick<Fundamentals, "trailingEpsSource"> | undefined): string | undefined {
  return fundamentals?.trailingEpsSource === "served"
    ? "EPS (TTM) and P/E (TTM) are Gloom Cloud's trailing figures, not the last four filed quarters'."
    : undefined;
}

type PriceEarningsBasis = Pick<Fundamentals, "financialCurrency" | "ttmConversion" | "epsCurrency" | "trailingPEConversion">;

/** The trailing EPS in the price's currency: converted at the rate the served P/E used when it says so. */
export function priceEarningsEps(fundamentals: Pick<Fundamentals, "eps" | "trailingPEConversion"> | undefined): number | undefined {
  const eps = fundamentals?.eps;
  const rate = fundamentals?.trailingPEConversion?.rate;
  return typeof eps === "number" && typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? eps * rate : eps;
}

/**
 * The trailing P/E's footnote: the rate its EPS was converted at when that EPS is in another currency than the
 * price, or that it divides a spot price by EPS converted at report-date rates.
 */
export function convertedPriceEarningsNote(fundamentals: PriceEarningsBasis | undefined, quoteCurrency?: string): string | undefined {
  const conversion = fundamentals?.trailingPEConversion;
  const from = conversion?.from?.trim();
  const to = resolveCurrencyUnit(quoteCurrency).currency;
  if (from && to && from !== to && typeof conversion?.rate === "number" && Number.isFinite(conversion.rate) && conversion.rate > 0) {
    return `P/E (TTM): price over EPS converted at 1 ${from} = ${Number(conversion.rate.toPrecision(5))} ${to}.`;
  }
  return (ttmConvertedFrom(fundamentals) && fundamentals?.ttmConversion?.eps === "report_date") || epsConversionNote(fundamentals)
    ? "P/E (TTM): spot price over EPS at report-date rates."
    : undefined;
}
