import type { Fundamentals, TickerFinancials } from "../types/financials";
import { resolveCurrencyUnit } from "./currency-units";

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
