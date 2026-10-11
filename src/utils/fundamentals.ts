import type { Fundamentals, TickerFinancials } from "../types/financials";

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

/** The trailing P/E's footnote when it divides a spot price by EPS converted at report-date rates. */
export function convertedPriceEarningsNote(fundamentals: Pick<Fundamentals, "financialCurrency" | "ttmConversion"> | undefined): string | undefined {
  return ttmConversionNote(fundamentals) && fundamentals?.ttmConversion?.eps === "report_date"
    ? "P/E (TTM): spot price over EPS at report-date rates."
    : undefined;
}
