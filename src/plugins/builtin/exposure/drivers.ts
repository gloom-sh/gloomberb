import type { ExposureExtensionObservation, ExposurePayload } from "../../../api-client/exposure";
import { formatCompact, formatNumber } from "../../../utils/format";
import type { ExposureRow } from "./model";

export function driverUnits(row: ExposureExtensionObservation): string {
  const currency = row.currency ?? "Currency";
  return ({ currency, currency_per_share: `${currency}/share`, currency_per_unit: `${currency}/${row.dimensions?.unit ?? "unit"}`,
    percent: "%", basis_points: "bp", ratio: "x", volume: row.dimensions?.unit ?? "Volume" } as Record<string, string>)[row.units] ?? row.units;
}
export function driverValue(row: ExposureExtensionObservation): string {
  const number = (value: number) => Math.abs(value) >= 10_000 ? formatCompact(value, { fixedDecimals: true }) : formatNumber(value, Number.isInteger(value) ? 0 : 2);
  const qualifier = ({ approximately: "≈ ", at_least: "≥ ", at_most: "≤ ", greater_than: "> ", less_than: "< " } as Record<string, string>)[row.qualifier ?? "exact"] ?? "";
  if (row.value !== null) return `${qualifier}${number(row.value)}`;
  if (row.range?.low != null && row.range.high != null) return `${qualifier}${number(row.range.low)} to ${number(row.range.high)}`;
  if (row.range?.low != null) return `${row.qualifier === "greater_than" ? ">" : "≥"} ${number(row.range.low)}`;
  if (row.range?.high != null) return `${row.qualifier === "less_than" ? "<" : "≤"} ${number(row.range.high)}`;
  return row.valueText ?? (row.status ? row.status.charAt(0).toUpperCase() + row.status.slice(1) : "Unknown");
}
export function driverRows(data: ExposurePayload): ExposureRow[] {
  return data.holdings.flatMap(holding => (holding.extensions ?? []).map(driver => ({
    id: `${holding.symbol}:${driver.id}`, symbol: holding.symbol, shockId: "", label: driver.label,
    basis: null, period: driver.period ?? null, exposure: null, impact: null,
    weight: holding.weight, classification: "unknown" as const, incomplete: true,
    driver, unknowns: driver.notes ?? [],
    components: [{ id: driver.id, shockId: "", label: driver.label, channel: "extension" as const,
      order: 0, basis: null, period: driver.period ?? null, classification: "unknown" as const,
      exposurePct: null, impactPct: null, evidence: driver.evidence, path: [], unknowns: driver.notes ?? [] }],
  })));
}
