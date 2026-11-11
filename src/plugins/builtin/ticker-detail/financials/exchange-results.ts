import { useCallback, useMemo } from "react";
import { apiClient } from "../../../../api-client";
import type { ExchangeAnnouncementsPayload } from "../../../../api-client/exchange-announcements";
import { createPluginCache } from "../../../../data/plugin-cache";
import { useAsyncResource } from "../../../../public/react";
import { exchangeResultsNotes, loadExchangeResults, RESULTS_ANNOUNCEMENT_LIMIT, type ExchangeAnnouncementsReader } from "../../../../utils/exchange-results";
import { nonUsSecListingVenue } from "../../../../utils/sec";
import { loadCloudResource } from "../../shared/cloud-resource";

/** Gloom Cloud keeps an HKEXnews list ten minutes; a results announcement comes twice a year, so ten minutes here too. */
const exchangeResultsCache = createPluginCache<ExchangeAnnouncementsPayload>({
  kind: "exchange-results", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 10 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});

type AnnouncementsClient = Pick<typeof apiClient, "getCloudExchangeAnnouncements">;

/** An HKEX company's results announcements, read through the cache. */
function cachedReader(client: AnnouncementsClient, force = false): ExchangeAnnouncementsReader {
  return async (listing) => (await loadCloudResource(exchangeResultsCache, listing.symbol,
    () => client.getCloudExchangeAnnouncements({ ...listing, limit: RESULTS_ANNOUNCEMENT_LIMIT, kind: "results" }), { force })).payload;
}

/** The periods a table's filled-period note already dates by an announcement, whose day the lines do not repeat. */
type DatedPeriods = Parameters<typeof exchangeResultsNotes>[1];

/**
 * "Latest half year 2026-06-30, interim results announced 2026-08-20 (HKEXnews)." and what came out after it, for an
 * HKEX company's statements report; nothing for another listing, or when the read fails or takes over 4 s.
 */
export async function loadExchangeResultsNotes(
  client: AnnouncementsClient,
  listing: { symbol: string; exchange?: string },
  latestPeriod: string | null,
  dated?: DatedPeriods,
): Promise<string[]> {
  const results = await loadExchangeResults(cachedReader(client), listing, latestPeriod);
  return results ? exchangeResultsNotes(results, dated) : [];
}

/** The same lines for FA's footer: read only for an HKEX listing with statements, and nothing while they load. */
export function useExchangeResultsNotes(
  symbol: string | null | undefined,
  exchange: string | undefined,
  latestPeriod: string | null,
  dated?: DatedPeriods,
): string[] {
  const enabled = !!symbol && !!latestPeriod && nonUsSecListingVenue(symbol, exchange) === "HKEX";
  const loader = useCallback(async (force: boolean) => (
    await loadExchangeResults(cachedReader(apiClient, force), { symbol: symbol!, exchange }, latestPeriod)
  ), [exchange, latestPeriod, symbol]);
  const { data } = useAsyncResource(enabled ? loader : null);
  return useMemo(() => enabled && data ? exchangeResultsNotes(data, dated) : [], [enabled, data, dated]);
}
