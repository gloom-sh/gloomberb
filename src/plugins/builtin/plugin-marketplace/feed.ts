import { createThrottledFetch } from "../../../utils/throttled-fetch";
import type { RegistryFeed, RegistryPlugin } from "./model";

/**
 * Exported so the hosted build's CSP can be checked against it. The browser
 * renderer can only reach origins listed in `connect-src`, and a blocked fetch
 * shows up as an empty catalog rather than an error, so the two are pinned
 * together by a test.
 */
export const REGISTRY_ORIGIN = "https://plugins.gloom.sh";
const REGISTRY_URL = `${REGISTRY_ORIGIN}/registry.json`;
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
      const response = await registryFetch.fetch(REGISTRY_URL);
      if (!response.ok) throw new Error(`Registry request failed (${response.status})`);
      return parseFeed(await response.json());
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
