import type { Fundamentals } from "../types/financials";

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
