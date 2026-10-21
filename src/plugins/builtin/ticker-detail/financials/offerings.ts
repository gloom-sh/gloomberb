import { useCallback, useMemo } from "react";
import { apiClient } from "../../../../api-client";
import { createPluginCache } from "../../../../data/plugin-cache";
import { useAsyncResource } from "../../../../public/react";
import type { TickerFinancials } from "../../../../types/financials";
import { fetchOfferingFilings, offeringNote, offeringsAfter, type OfferingFiling } from "../../../../utils/cash-runway";
import { latestFinancialPeriod } from "../../../../utils/latest-financial-period";
import { nonUsSecListingVenue } from "../../../../utils/sec";
import { cachedCloudResource, loadCloudResource } from "../../shared/cloud-resource";

/** A prospectus is filed days before the cash lands; an hour-old list is recent enough for the note. */
export const offeringFilingsCache = createPluginCache<OfferingFiling[]>({
  kind: "offering-filings", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});

/** The newest balance sheet the statements carry: the latest quarter's, or the latest year's without quarters. */
export function latestBalanceSheetDate(financials: Pick<TickerFinancials, "annualStatements" | "quarterlyStatements"> | null | undefined): string | null {
  const latest = latestFinancialPeriod([...financials?.quarterlyStatements ?? [], ...financials?.annualStatements ?? []], (row) => row.date);
  return latest?.date ?? null;
}

/** Offering prospectuses for a US company; a listing abroad files none of these. */
function offeringSymbol(symbol: string | null | undefined, exchange: string | undefined): string | null {
  const key = symbol?.trim().toUpperCase();
  return key && !nonUsSecListingVenue(key, exchange) ? key : null;
}

/** The note that an offering filed after `periodEnd` is not in the cash yet, for a report. A failed read leaves it out. */
export async function loadOfferingNote(
  client: Parameters<typeof fetchOfferingFilings>[0],
  listing: { symbol: string; exchange?: string },
  periodEnd: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  const key = offeringSymbol(listing.symbol, listing.exchange);
  if (!key || !periodEnd) return null;
  const { payload } = await loadCloudResource(offeringFilingsCache, key, () => fetchOfferingFilings(client, key, signal), { signal });
  return offeringNote(offeringsAfter(payload, periodEnd), periodEnd);
}

/**
 * The same note for a pane: read only while `enabled` (the views that show
 * cash), from the cached list first. Nothing while it loads or when the read
 * fails, as the note is context, not the data.
 */
export function useOfferingNote(symbol: string | null | undefined, exchange: string | undefined, periodEnd: string | null, enabled: boolean): string | null {
  const key = enabled && periodEnd ? offeringSymbol(symbol, exchange) : null;
  const loader = useCallback(async (force: boolean) => (
    await loadCloudResource(offeringFilingsCache, key!, () => fetchOfferingFilings(apiClient, key!), { force })
  ).payload, [key]);
  const cached = useMemo(() => key ? cachedCloudResource(offeringFilingsCache, key)?.payload ?? null : null, [key]);
  const { data } = useAsyncResource(key ? loader : null, { initialData: () => cached });
  const filings = data ?? cached;
  return key && periodEnd && filings ? offeringNote(offeringsAfter(filings, periodEnd), periodEnd) : null;
}
