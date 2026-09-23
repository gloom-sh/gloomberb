import { colors, priceColor } from "../../../theme/colors";
import { formatDetailDate as sharedFormatDetailDate, parseDisplayDate } from "../../../utils/datetime-format";
import type { BuildoutSource, BuildoutUpdate } from "./model/types";

export { truncateWithEllipsis as truncate } from "../../../utils/text-wrap";

export function text(value: unknown, fallback = "-") {
  if (value == null) return fallback;
  const stringValue = String(value).trim();
  return stringValue || fallback;
}

export function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  const stringValue = String(value).trim();
  return stringValue || null;
}

export function metricNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const raw = value.trim();
  if (!raw || raw === "-" || /^n\/a$/i.test(raw)) return null;
  const negative = raw.startsWith("(") && raw.endsWith(")");
  const suffixMatch = raw.match(/([KMBT])\s*%?\)?$/i);
  const suffix = suffixMatch?.[1]?.toUpperCase() ?? "";
  const multiplier = suffix === "K"
    ? 1_000
    : suffix === "M"
      ? 1_000_000
      : suffix === "B"
        ? 1_000_000_000
        : suffix === "T"
          ? 1_000_000_000_000
          : 1;
  const numeric = raw
    .replace(/[,$%+]/g, "")
    .replace(/[()]/g, "")
    .replace(/[KMBT]\s*$/i, "")
    .trim();
  const parsed = Number(numeric.match(/^-?\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(parsed)) return null;
  return (negative ? -parsed : parsed) * multiplier;
}

export function dateShort(value: string | null | undefined) {
  const date = parseDisplayDate(value);
  if (!date) return "-";
  return date.toISOString().slice(5, 10);
}

export function dateDetail(value: string | null | undefined) {
  const formatted = sharedFormatDetailDate(value, "");
  return formatted || null;
}

export function activityLabel(value: number | null | undefined) {
  if (value == null) return "-";
  if (value >= 2) return "High";
  if (value >= 1) return "Low";
  return "None";
}

export function activityColor(value: number | null | undefined, selected: boolean) {
  if (selected) return colors.selectedText;
  if (value == null || value <= 0) return colors.textMuted;
  return value >= 2 ? colors.warning : colors.neutral;
}

export function metricColor(value: unknown, selected = false) {
  if (selected) return colors.selectedText;
  const parsed = metricNumber(value);
  return parsed == null ? colors.textDim : priceColor(parsed);
}

export function criticalityColor(value: string | null | undefined, selected: boolean) {
  if (selected) return colors.selectedText;
  switch ((value ?? "").trim().toUpperCase()) {
    case "CORE":
      return colors.negative;
    case "CRITICAL":
      return colors.warning;
    case "IMPORTANT":
      return colors.neutral;
    case "SUPPORTING":
      return colors.textDim;
    case "PERIPHERAL":
      return colors.textMuted;
    default:
      return colors.textDim;
  }
}

export function tickerSymbol(value: string | null | undefined): string | null {
  const symbol = value?.trim();
  return symbol ? symbol.toUpperCase() : null;
}

export function tickerSearchText(symbols: readonly string[]) {
  return symbols
    .filter((symbol) => /^[A-Z]/.test(symbol))
    .map((symbol) => `$${symbol}`)
    .join(" ");
}

export function appendUniqueById<T extends { id: string }>(existing: readonly T[], incoming: readonly T[]) {
  const seen = new Set(existing.map((item) => item.id));
  const merged = [...existing];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

export function uniqueStrings(values: readonly string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function domainFromUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const hostname = new URL(value).hostname.replace(/^www\./, "");
    return hostname || null;
  } catch {
    return null;
  }
}

export function sourceDomains(sources: readonly BuildoutSource[] | null | undefined) {
  return uniqueStrings((sources ?? []).flatMap((source) => [
    source.domain ?? domainFromUrl(source.url) ?? "",
    ...(source.citations ?? []).map((citation) => domainFromUrl(citation.url) ?? ""),
  ]));
}

export interface SourceDetailEntry {
  url: string | null;
  domain: string | null;
  title: string | null | undefined;
  note: string | null | undefined;
  tier: string | null | undefined;
}

/** The source lines a site detail draws, each with its link when it has one. */
export function sourceDetailEntries(sources: readonly BuildoutSource[] | undefined, maxItems: number): SourceDetailEntry[] {
  return (sources ?? [])
    .flatMap((source) => {
      const flatUrl = source.url;
      const flatTitle = source.title ?? source.snippet ?? source.reasoning;
      const flat = flatUrl || flatTitle
        ? [{
          url: flatUrl ?? null,
          domain: source.domain ?? domainFromUrl(flatUrl) ?? null,
          title: flatTitle,
          note: source.reasoning ?? source.snippet,
          tier: source.tier,
        }]
        : [];
      const citations = (source.citations ?? []).map((citation) => ({
        url: citation.url ?? null,
        domain: domainFromUrl(citation.url) ?? null,
        title: citation.title ?? citation.excerpts?.[0] ?? null,
        note: citation.excerpts?.[0] ?? null,
        tier: source.tier,
      }));
      return [...flat, ...citations];
    })
    .filter((entry) => textOrNull(entry.domain ?? entry.title ?? entry.note) != null)
    .slice(0, maxItems);
}

export function intelSourceDomains(update: BuildoutUpdate) {
  return uniqueStrings([
    ...sourceDomains(update.contextSources),
    ...(update.sourceUrls ?? []).map((url) => domainFromUrl(url) ?? ""),
  ]);
}
