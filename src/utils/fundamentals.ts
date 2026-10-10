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
