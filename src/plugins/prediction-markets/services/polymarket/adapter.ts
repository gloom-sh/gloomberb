import {
  buildPredictionCatalogResourceKey,
} from "../../cache";
import {
  getPolymarketCategoryTagSlugs,
} from "../../categories";
import type {
  PredictionCategoryId,
  PredictionMarketSummary,
} from "../../types";
import {
  fetchJson,
  loadCachedPredictionResource,
  PREDICTION_CACHE_POLICIES,
} from "../fetch";
import {
  loadPolymarketEvent,
} from "./detail";
import {
  normalizePolymarketCatalog,
  reconcilePolymarketSearchEvents,
} from "./normalize";
import type {
  PolymarketEventRecord,
  PolymarketSearchResponse,
} from "./types";

export { normalizePolymarketMarket } from "./normalize";
export { loadPolymarketDetail } from "./detail";

const POLYMARKET_CATALOG_OFFSETS = [0, 200, 400];
const POLYMARKET_CATEGORY_OFFSETS = [0, 200];

function buildPolymarketCatalogUrl(offset: number, tagSlug?: string, limit = 200): string {
  const url = new URL("https://gamma-api.polymarket.com/events");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  if (tagSlug) url.searchParams.set("tag_slug", tagSlug);
  return url.toString();
}

function buildPolymarketSearchUrl(query: string, limit = 40): string {
  const url = new URL("https://gamma-api.polymarket.com/public-search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit_per_type", String(limit));
  url.searchParams.set("search_profiles", "false");
  url.searchParams.set("search_tags", "false");
  url.searchParams.set("events_status", "open");
  url.searchParams.set("optimized", "true");
  return url.toString();
}

async function loadPolymarketCatalogPages(
  offsets: number[],
  tagSlug?: string,
  limit = 200,
  signal?: AbortSignal,
): Promise<PolymarketEventRecord[]> {
  const results = await Promise.allSettled(
    offsets.map((offset) =>
      fetchJson<PolymarketEventRecord[]>(
        buildPolymarketCatalogUrl(offset, tagSlug, limit),
        signal,
      ),
    ),
  );
  const pages = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (pages.length > 0) return pages;

  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  return [];
}

export async function loadPolymarketCatalog(
  searchQuery = "",
  categoryId: PredictionCategoryId = "all",
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<PredictionMarketSummary[]> {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const requestedLimit = Math.max(1, Math.min(200, options.limit ?? 200));
  const pageLimit = Math.max(20, requestedLimit);
  return await loadCachedPredictionResource(
    "catalog",
    `${buildPredictionCatalogResourceKey("polymarket", categoryId, normalizedQuery)}:${requestedLimit}`,
    async () => {
      if (normalizedQuery.length > 0) {
        const response = await fetchJson<PolymarketSearchResponse>(
          buildPolymarketSearchUrl(normalizedQuery, Math.min(40, pageLimit)),
          options.signal,
        );
        const searchEvents = (response.events ?? []).slice(0, requestedLimit);
        const hydratedEvents = (
          await Promise.all(
            [...new Set(searchEvents.map((event) => event.id).filter(Boolean))]
              .map((eventId) => loadPolymarketEvent(eventId, options.signal)),
          )
        ).filter((event): event is PolymarketEventRecord => event != null);
        const resolvedEvents = reconcilePolymarketSearchEvents(
          searchEvents,
          hydratedEvents,
        );
        return normalizePolymarketCatalog(
          resolvedEvents,
          normalizedQuery,
          categoryId,
        ).slice(0, requestedLimit);
      }

      if (categoryId !== "all") {
        const tagSlugs = getPolymarketCategoryTagSlugs(categoryId);
        const categoryPages = await Promise.all(
          tagSlugs.map((tagSlug) =>
            loadPolymarketCatalogPages(
              options.limit ? [0] : POLYMARKET_CATEGORY_OFFSETS,
              tagSlug,
              pageLimit,
              options.signal,
            ).catch(() => []),
          ),
        );
        const categorized = normalizePolymarketCatalog(
          categoryPages.flat(),
          "",
          categoryId,
        );
        if (categorized.length > 0) return categorized.slice(0, requestedLimit);
      }

      const pages = await loadPolymarketCatalogPages(
        options.limit ? [0] : POLYMARKET_CATALOG_OFFSETS,
        undefined,
        pageLimit,
        options.signal,
      );
      return normalizePolymarketCatalog(pages, "", categoryId).slice(0, requestedLimit);
    },
    PREDICTION_CACHE_POLICIES.catalog,
  );
}
