import { MISSING_VALUE } from "../../../../utils/format";
import { colors } from "../../../../theme/colors";
import type { BuildoutReportSection, RawObject } from "../model/types";
import { dateShort, textOrNull, uniqueStrings } from "../format";

export function valueWithOriginal(value?: string | null, original?: string | null) {
  const main = textOrNull(value);
  const originalValue = textOrNull(original);
  if (!originalValue || originalValue === main) return main;
  return main ? `${main} (${originalValue})` : originalValue;
}

export function dateCell(value?: string | null) {
  const short = dateShort(value);
  return short === MISSING_VALUE ? null : short;
}

export function booleanText(value: boolean | null | undefined) {
  if (value == null) return null;
  return value ? "Yes" : "No";
}

export function recommendationColor(value: string | null | undefined) {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("buy")) return colors.positive;
  if (normalized.includes("sell")) return colors.negative;
  if (normalized.includes("hold")) return colors.neutral;
  return colors.textDim;
}

export function detailListValues(values: readonly (string | null | undefined)[], existing: readonly (string | null | undefined)[] = []) {
  const existingSet = new Set(existing.map((item) => item?.trim()).filter(Boolean));
  return uniqueStrings(values.filter((item): item is string => textOrNull(item) != null))
    .filter((item) => !existingSet.has(item));
}

function metadataValue(value: unknown) {
  if (value == null) return null;
  if (typeof value === "string") return textOrNull(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return booleanText(value);
  if (Array.isArray(value)) {
    const values = value.map(textOrNull).filter((item): item is string => item != null);
    return values.length > 0 ? values.slice(0, 5).join(", ") : null;
  }
  return null;
}

function metadataLabel(key: string) {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function metadataSpecs(metadata: RawObject | null | undefined) {
  if (!metadata) return [];
  return Object.entries(metadata)
    .flatMap(([key, value]) => {
      const normalized = metadataValue(value);
      return normalized ? [{ label: metadataLabel(key), value: normalized }] : [];
    })
    .slice(0, 12);
}

export function reportSectionText(section: BuildoutReportSection) {
  return section.markdown ?? section.body ?? section.content ?? section.section ?? null;
}
