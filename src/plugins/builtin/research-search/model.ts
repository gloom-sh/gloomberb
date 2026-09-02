import type {
  CloudSavedSearch,
  CloudSavedSearchFilters,
  CloudSearchChunkMetadata,
  CloudSearchDocType,
  CloudSearchHit,
  CloudSearchSort,
} from "../../../api-client";
import type { CloudSearchParams } from "../../../api-client/paths";
import type { DataTableColumn } from "../../../components";

export const RESEARCH_SEARCH_PANE_ID = "research-search";
export const RESEARCH_SEARCH_TEMPLATE_ID = "research-search-pane";
const RESEARCH_SEARCH_PAGE_SIZE = 40;

/** One pane per query, so two searches can sit side by side. */
export function researchSearchInstanceId(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return `${RESEARCH_SEARCH_PANE_ID}:main`;
  return `${RESEARCH_SEARCH_PANE_ID}:${encodeURIComponent(trimmed).replace(/%/g, "~")}`;
}

export type SearchRangeKey = "all" | "7d" | "30d" | "1y" | "custom";

export interface SearchFilters {
  tickers: string[];
  docTypes: CloudSearchDocType[];
  range: SearchRangeKey;
  /** Absolute bounds; presets recompute `from` per request so the window stays relative. */
  from?: string;
  to?: string;
  sort: CloudSearchSort;
}

export const DEFAULT_FILTERS: SearchFilters = {
  tickers: [],
  docTypes: [],
  range: "all",
  sort: "relevance",
};

/** An empty selection means every type, so there is no explicit "all" option. */
export const DOC_TYPE_OPTIONS: Array<{ value: CloudSearchDocType; label: string }> = [
  { value: "transcript", label: "Calls" },
  { value: "news", label: "News" },
  { value: "filing", label: "Filings" },
];

export const RANGE_OPTIONS: Array<{ value: SearchRangeKey; label: string }> = [
  { value: "all", label: "Any time" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "1y", label: "1Y" },
];

export const SORT_OPTIONS: Array<{ value: CloudSearchSort; label: string }> = [
  { value: "relevance", label: "Relevance" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
];

const RANGE_DAYS: Record<Exclude<SearchRangeKey, "all" | "custom">, number> = {
  "7d": 7,
  "30d": 30,
  "1y": 365,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseTickerFilter(value: string): string[] {
  return [...new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => entry.length > 0),
  )];
}

/** Resolves the preset window at request time; a custom range keeps its stored bounds. */
function resolveRangeBounds(
  filters: SearchFilters,
  now = Date.now(),
): { from?: string; to?: string } {
  if (filters.range === "custom") return { from: filters.from, to: filters.to };
  if (filters.range === "all") return {};
  const days = RANGE_DAYS[filters.range];
  return { from: new Date(now - days * MS_PER_DAY).toISOString() };
}

export function buildSearchParams(
  query: string,
  filters: SearchFilters,
  options: { offset?: number; limit?: number; now?: number } = {},
): CloudSearchParams {
  const { from, to } = resolveRangeBounds(filters, options.now);
  return {
    query,
    ...(filters.tickers.length > 0 ? { tickers: filters.tickers } : {}),
    ...(filters.docTypes.length > 0 ? { docTypes: filters.docTypes } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    sort: filters.sort,
    limit: options.limit ?? RESEARCH_SEARCH_PAGE_SIZE,
    ...(options.offset ? { offset: options.offset } : {}),
    // A long press release matches on a dozen chunks, and repeating it a dozen
    // times buries every other document. One row per document, best chunk wins.
    distinct: true,
  };
}

export function filtersToSaved(filters: SearchFilters, now = Date.now()): CloudSavedSearchFilters {
  const { from, to } = resolveRangeBounds(filters, now);
  return {
    ...(filters.tickers.length > 0 ? { tickers: filters.tickers } : {}),
    ...(filters.docTypes.length > 0 ? { docTypes: filters.docTypes } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

export function filtersFromSaved(saved: CloudSavedSearch): SearchFilters {
  const filters = saved.filters ?? {};
  return {
    tickers: filters.tickers ?? [],
    docTypes: filters.docTypes ?? [],
    range: filters.from || filters.to ? "custom" : "all",
    from: filters.from,
    to: filters.to,
    // Sort is a viewing preference, not part of what the server matches.
    sort: "relevance",
  };
}

export function describeFilters(filters: CloudSavedSearchFilters | undefined): string {
  const parts = [
    filters?.tickers?.length ? filters.tickers.join(" ") : null,
    filters?.docTypes?.length ? filters.docTypes.map(docTypeLabel).join("/") : null,
    filters?.from ? `since ${formatHitDate(filters.from)}` : null,
    filters?.to ? `to ${formatHitDate(filters.to)}` : null,
  ].filter((part): part is string => !!part);
  return parts.join(" · ");
}

export function docTypeLabel(docType: CloudSearchDocType | string): string {
  switch (docType) {
    case "transcript":
      return "Call";
    case "news":
      return "News";
    case "filing":
      return "Filing";
    default:
      return String(docType);
  }
}

/** Compact table label: filings show their form, which is more useful than "Filing". */
export function hitTypeLabel(hit: CloudSearchHit): string {
  if (hit.docType === "filing") return hit.metadata?.form?.trim() || "FILING";
  return hit.docType === "transcript" ? "CALL" : "NEWS";
}

export function formatHitDate(value: string | null | undefined): string {
  if (!value) return "\u2014";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "\u2014";
  return date.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "2-digit" });
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Date for a column too narrow for a full one: the age while it is fresh
 * ("3h"), the day for the rest of this year ("Aug 30"), the month and year
 * beyond that ("Aug 2025"). Empty rather than a dash when unknown, so a row
 * without a date shows nothing rather than a placeholder.
 */
export function formatHitDateShort(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "";
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return "";
  const age = now - time;
  if (age >= 0 && age < MS_PER_HOUR) return `${Math.max(1, Math.floor(age / 60_000))}m`;
  if (age >= 0 && age < 24 * MS_PER_HOUR) return `${Math.floor(age / MS_PER_HOUR)}h`;
  if (date.getFullYear() === new Date(now).getFullYear()) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/**
 * Who or what a hit's text came from, shorter than `chunkAttribution` because
 * the command bar sets it before the ticker on one line: the wire for news,
 * "speaker, role" for a call, the section for a filing (its form is the badge).
 */
export function hitLeadIn(hit: Pick<CloudSearchHit, "docType" | "metadata">): string {
  const metadata = hit.metadata;
  if (!metadata) return "";
  if (hit.docType === "transcript") {
    return [metadata.speaker, metadata.role]
      .map((part) => part?.trim())
      .filter((part): part is string => !!part)
      .join(", ");
  }
  if (hit.docType === "filing") return metadata.section?.trim() || "";
  return metadata.source?.trim() || "";
}

/** Speaker, wire source, or filing section — whatever identifies a chunk's origin. */
export function chunkAttribution(
  docType: CloudSearchDocType,
  metadata: CloudSearchChunkMetadata | undefined,
): string {
  if (!metadata) return "";
  if (docType === "transcript") {
    const speaker = [metadata.speaker, metadata.role, metadata.company]
      .filter((part) => !!part?.trim())
      .join(" · ");
    return metadata.isQa && speaker ? `${speaker} · Q&A` : speaker;
  }
  if (docType === "filing") return metadata.section?.trim() || "";
  return metadata.source?.trim() || "";
}

/**
 * Columns a wrapped paragraph gets in the document view. The scroll box keeps
 * one column of text inset on the left, and its vertical scrollbar sits in the
 * last column of the pane, so those are the only two the body cannot use.
 */
export function documentBodyWidth(width: number): number {
  return Math.max(20, Math.floor(width) - 2);
}

type SearchColumnId = "ticker" | "type" | "date" | "title" | "match";

export interface SearchColumn extends DataTableColumn {
  id: SearchColumnId;
}

export function buildResultColumns(width: number): SearchColumn[] {
  // Wide enough for a five-letter symbol plus the badge's own padding.
  const tickerWidth = 8;
  const typeWidth = 7;
  const dateWidth = 10;
  const fixed = tickerWidth + typeWidth + dateWidth + 8;
  const remaining = Math.max(24, width - fixed);
  // The snippet is what makes a hit judgeable, so it takes the larger share.
  const titleWidth = Math.max(14, Math.min(38, Math.round(remaining * 0.4)));
  return [
    { id: "ticker", label: "TICKER", width: tickerWidth, align: "left" },
    { id: "type", label: "TYPE", width: typeWidth, align: "left" },
    { id: "date", label: "DATE", width: dateWidth, align: "left" },
    { id: "title", label: "TITLE", width: titleWidth, align: "left" },
    { id: "match", label: "MATCH", width: Math.max(10, remaining - titleWidth), align: "left" },
  ];
}

/**
 * Identity of the thing a row stands for. Distinct search returns one row per
 * source document but picks whichever chunk scored best, so the same document
 * can arrive on two pages under two different chunk ids.
 */
function hitDocumentKey(hit: CloudSearchHit): string {
  return `${hit.docType}:${hit.sourceId}`;
}

/** Paged responses can overlap when new documents land between requests. */
export function appendUniqueHits(current: CloudSearchHit[], next: CloudSearchHit[]): CloudSearchHit[] {
  if (next.length === 0) return current;
  const seen = new Set(current.map(hitDocumentKey));
  const merged = [...current];
  for (const hit of next) {
    const key = hitDocumentKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  return merged;
}

/** Chunks behind a collapsed row, so hiding the rest stays visible. */
export function hitMatchCountLabel(hit: CloudSearchHit): string {
  const count = hit.matchCount ?? 0;
  return count > 1 ? `${count}\u00d7 ` : "";
}

export function savedSearchName(query: string, filters: SearchFilters): string {
  const scope = filters.tickers.length > 0 ? ` (${filters.tickers.join(" ")})` : "";
  return `${query.trim()}${scope}`.slice(0, 120);
}
