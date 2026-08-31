import { createThrottledFetch } from "../../../utils/throttled-fetch";
import type { RegistryFeed, RegistryPlugin } from "./model";

/**
 * The custom domain is canonical. The workers.dev origin is the same Worker and
 * is tried only if the first request fails, which covers a DNS or certificate
 * problem on the custom hostname without taking the marketplace down.
 */
const REGISTRY_URLS = [
  "https://plugins.gloom.sh/registry.json",
  "https://gloomberb-plugins.lyser.workers.dev/registry.json",
] as const;
const FRESH_MS = 15 * 60_000;

const registryFetch = createThrottledFetch({
  requestsPerMinute: 20,
  maxRetries: 2,
  timeoutMs: 10_000,
  backoffBaseMs: 500,
  dedupeGetRequests: true,
  defaultHeaders: { Accept: "application/json" },
});

interface CacheEntry {
  plugins: RegistryPlugin[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<RegistryPlugin[]> | null = null;

export interface FeedResult {
  plugins: RegistryPlugin[];
  fetchedAt: number | null;
  /** Served from cache after a failed refresh. */
  stale: boolean;
  error: string | null;
}

function parseFeed(body: unknown): RegistryPlugin[] {
  const feed = body as RegistryFeed | null;
  if (!feed || !Array.isArray(feed.plugins)) throw new Error("Malformed registry feed");
  // Only fields the pane actually reads are required; the rest degrade to defaults
  // so a feed built by a newer registry version still renders.
  return feed.plugins.filter((plugin): plugin is RegistryPlugin => (
    !!plugin && typeof plugin.id === "string" && typeof plugin.name === "string"
  ));
}

export async function loadRegistry(options: { force?: boolean } = {}): Promise<FeedResult> {
  const now = Date.now();
  if (!options.force && cache && now - cache.fetchedAt < FRESH_MS) {
    return { plugins: cache.plugins, fetchedAt: cache.fetchedAt, stale: false, error: null };
  }

  if (!inFlight) {
    inFlight = (async () => {
      let lastError: unknown = new Error("No registry endpoint configured");
      for (const url of REGISTRY_URLS) {
        try {
          const response = await registryFetch.fetch(url);
          if (!response.ok) throw new Error(`Registry request failed (${response.status})`);
          return parseFeed(await response.json());
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    })().finally(() => {
      inFlight = null;
    });
  }

  try {
    const plugins = await inFlight;
    cache = { plugins, fetchedAt: Date.now() };
    return { plugins, fetchedAt: cache.fetchedAt, stale: false, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A stale catalog is far more useful than an empty pane, and the footer
    // says which one the user is looking at.
    if (cache) return { plugins: cache.plugins, fetchedAt: cache.fetchedAt, stale: true, error: message };
    return { plugins: [], fetchedAt: null, stale: false, error: message };
  }
}

export function registryPluginUrl(id: string): string {
  return `https://gloom.sh/plugins/${id}`;
}
