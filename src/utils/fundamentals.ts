import type { EnterpriseValueCheck, Fundamentals, TickerFinancials } from "../types/financials";
import { resolveCurrencyUnit } from "./currency-units";
import { formatCompact } from "./format";

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

/** What names the currency of the trailing figures: the fundamentals' own labels, else the statements'. */
type FundamentalsCurrencies = Pick<TickerFinancials, "financialCurrency"> & {
  fundamentals?: Pick<Fundamentals, "financialCurrency" | "epsCurrency"> | null;
};

/**
 * The currency of the trailing EPS, revenue, income and cash flows: the one the fundamentals declare, else the
 * one the statements report in. Never the quote's, which a depositary receipt can differ from (USD quote, TWD books).
 */
export function fundamentalsCurrency(
  financials: FundamentalsCurrencies | null | undefined,
): string | undefined {
  return financials?.fundamentals?.financialCurrency?.trim() || financials?.financialCurrency?.trim() || undefined;
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

/**
 * "TTM converted from EUR (1 EUR = 1.1257 USD, 2026-10-09); EPS at report-date rates.": what a converted trailing
 * block was converted from, at which rate and when. Undefined for a block in the currency the company reports in.
 */
export function ttmConversionNote(fundamentals: Pick<Fundamentals, "financialCurrency" | "ttmConversion"> | undefined): string | undefined {
  const conversion = fundamentals?.ttmConversion;
  const from = conversion?.from?.trim();
  const to = fundamentals?.financialCurrency?.trim();
  if (!conversion || !from || !to || from === to) return undefined;
  const rate = typeof conversion.rate === "number" && Number.isFinite(conversion.rate) && conversion.rate > 0
    ? `1 ${from} = ${Number(conversion.rate.toPrecision(5))} ${to}`
    : undefined;
  const asOf = conversion.asOf && ISO_DAY.test(conversion.asOf) ? conversion.asOf : undefined;
  const basis = [rate, asOf].filter(Boolean).join(", ");
  const eps = conversion.eps === "report_date" ? "; EPS at report-date rates" : "";
  return `TTM converted from ${from}${basis ? ` (${basis})` : ""}${eps}.`;
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
  return (ttmConversionNote(fundamentals) && fundamentals?.ttmConversion?.eps === "report_date") || epsConversionNote(fundamentals)
    ? "P/E (TTM): spot price over EPS at report-date rates."
    : undefined;
}
