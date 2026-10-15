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
 * matches is the one shown, and a withdrawn one is no longer shown. A check merged beside another source's EV is none.
 */
export function enterpriseValueCheck(
  fundamentals: Pick<Fundamentals, "enterpriseValue" | "enterpriseValueCheck" | "unavailableFields"> | undefined,
): EnterpriseValueCheck | undefined {
  const check = fundamentals?.enterpriseValueCheck;
  if (!check || !finiteNumber(check.source) || !check.currency) return undefined;
  if (check.status === "withdrawn") {
    return fundamentals?.enterpriseValue === undefined && fundamentals.unavailableFields?.includes("enterpriseValue")
      && finiteNumber(check.computed) ? check : undefined;
  }
  return fundamentals?.enterpriseValue === check.source ? check : undefined;
}

/**
 * Whether the provider's EV was withdrawn: retracted (`unavailableFields`) and none served in its place, by the
 * served check or by Gloom Cloud's own validation of the source observation, which leaves no check.
 */
export function enterpriseValueWithdrawn(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): boolean {
  return fundamentals?.enterpriseValue === undefined && !!fundamentals?.unavailableFields?.includes("enterpriseValue");
}

/** "(provider)" beside an EV more than 5% from market cap + debt - cash, or "unavailable" for a withdrawn one. */
export function enterpriseValueLabel(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): "provider" | "unavailable" | undefined {
  const status = enterpriseValueCheck(fundamentals)?.status;
  return status === "differs" ? "provider" : status === "withdrawn" || enterpriseValueWithdrawn(fundamentals) ? "unavailable" : undefined;
}

/**
 * The reconciliation line under a labelled or withdrawn EV: "EV 61.75B USD (provider) vs 63.75B computed from market
 * cap + total debt - cash (balance sheet 2026-06-30)." For an EV withdrawn without a check, that the source failed
 * validation. Undefined when the EV matches, is unchecked, or has no check. Read it from the fundamentals the rows
 * show (atRegularSessionPrice moves the check with the EV and the market cap), so its figures are theirs.
 */
export function enterpriseValueReconciliationNote(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): string | undefined {
  const check = enterpriseValueCheck(fundamentals);
  if (!check && enterpriseValueWithdrawn(fundamentals)) return "EV unavailable: the provider's figure failed validation.";
  if (!check || !finiteNumber(check.computed) || (check.status !== "differs" && check.status !== "withdrawn")) return undefined;
  const source = `${formatCompact(check.source)} ${check.currency}`;
  const computed = formatCompact(check.computed);
  const basis = `market cap + total debt - cash${check.balanceSheetDate ? ` (balance sheet ${check.balanceSheetDate})` : ""}`;
  if (check.status === "differs") return `EV ${source} (provider) vs ${computed} computed from ${basis}.`;
  const ratio = check.computed > 0 ? ` is ${(check.source / check.computed).toFixed(1)}x` : " is far from";
  return `EV unavailable: the provider's ${source}${ratio} the ${computed} computed from ${basis}.`;
}

/**
 * The currency of the trailing EPS, revenue, income and cash flows: the one the fundamentals declare, else the
 * one the statements report in. Never the quote's, which a depositary receipt can differ from (USD quote, TWD books).
 */
export function fundamentalsCurrency(
  financials: Pick<TickerFinancials, "fundamentals" | "financialCurrency"> | null | undefined,
): string | undefined {
  return financials?.fundamentals?.financialCurrency?.trim() || financials?.financialCurrency?.trim() || undefined;
}

/**
 * The currency of the trailing EPS: the one stated for it when it differs from the block's amounts (an EPS converted
 * to the listing's currency beside revenue left in the reporting one), else the block's.
 */
export function fundamentalsEpsCurrency(
  financials: Pick<TickerFinancials, "fundamentals" | "financialCurrency"> | null | undefined,
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
