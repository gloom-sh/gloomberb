import { apiClient } from "../../../api-client";
import type { IpoCalendarParams, IpoCalendarPayload, IpoDeal, IpoSourceHealth } from "../../../api-client/ipo";
import type { HeadlessPaneApiClient } from "../../../types/plugin";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer, type CloudResource } from "../shared/cloud-resource";

/**
 * The board moves on pricing days, not minutes, so a quarter hour of
 * freshness is enough; the week-long expiry is what keeps an offline start
 * usable. The payload is the same for every account.
 */
export const ipoCalendarCache = createPluginCache<IpoCalendarPayload>({
  kind: "ipo-calendar",
  source: "gloom-cloud",
  schemaVersion: 2,
  policy: { staleMs: 15 * 60_000, expireMs: 7 * 86_400_000 },
});

const CACHE_KEY = "board";
const UNAVAILABLE = "The IPO calendar is not available on this server yet.";
const STATUSES = new Set(["filed", "upcoming", "priced", "listed", "postponed", "withdrawn"]);
const REGIONS = new Set(["us", "apac", "europe", "other"]);

const dayOrNull = (value: unknown) => value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const textOrNull = (value: unknown) => value === null || typeof value === "string";
const numberOrNull = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));

function validFirstDay(value: IpoDeal["firstDay"]): boolean {
  return value === null || (!!value && typeof value.session === "string" && dayOrNull(value.session)
    && numberOrNull(value.open) && typeof value.close === "number" && Number.isFinite(value.close)
    && numberOrNull(value.returnPct));
}

function validDeal(deal: IpoDeal): boolean {
  return !!deal
    && text(deal.id) && text(deal.company) && textOrNull(deal.companyLocal)
    && textOrNull(deal.symbol) && text(deal.mic) && textOrNull(deal.exchange)
    && typeof deal.venue === "string" && typeof deal.country === "string"
    && STATUSES.has(deal.status)
    && dayOrNull(deal.listingDate) && dayOrNull(deal.subscriptionOpen) && dayOrNull(deal.subscriptionClose) && dayOrNull(deal.filedDate)
    && textOrNull(deal.currency)
    && numberOrNull(deal.priceLow) && numberOrNull(deal.priceHigh) && numberOrNull(deal.offerPrice)
    && numberOrNull(deal.sharesOffered) && numberOrNull(deal.offerSize) && numberOrNull(deal.offerSizeUsd)
    && validFirstDay(deal.firstDay);
}

function validSource(source: IpoSourceHealth): boolean {
  return !!source && text(source.id) && Array.isArray(source.mics) && source.mics.every(text)
    && typeof source.ok === "boolean" && textOrNull(source.asOf);
}

/**
 * The server adds venues, listing types and fields over time, so a deal is
 * read for what the pane draws, a region it does not know files under other,
 * and one unreadable deal is left out rather than failing the whole board.
 */
export function validateIpoCalendar(data: IpoCalendarPayload): IpoCalendarPayload {
  if (!data || !text(data.asOf) || !Array.isArray(data.deals) || !Array.isArray(data.sources)) {
    throw new Error("The server returned an unreadable IPO calendar");
  }
  return {
    asOf: data.asOf,
    deals: data.deals.filter(validDeal).map((deal) => (REGIONS.has(deal.region) ? deal : { ...deal, region: "other" })),
    sources: data.sources.filter(validSource),
  };
}

/** Without params, the server's default window, which leaves out filed and withdrawn deals. */
export async function fetchIpoCalendar(
  client: Pick<HeadlessPaneApiClient, "getCloudIpoCalendar"> = apiClient,
  signal?: AbortSignal,
  params: IpoCalendarParams = {},
): Promise<IpoCalendarPayload> {
  try {
    return validateIpoCalendar(await client.getCloudIpoCalendar(params, { signal }));
  } catch (error) {
    // The route answers 503 until its first pass has run.
    throw unavailableOnServer(error, UNAVAILABLE, [404, 503]);
  }
}

/** The last good board, so the pane has rows before the first answer, and offline. */
export function getCachedIpoCalendar(): CloudResource<IpoCalendarPayload> | null {
  return cachedCloudResource(ipoCalendarCache, CACHE_KEY, validateIpoCalendar);
}

export function loadIpoCalendar(force = false): Promise<CloudResource<IpoCalendarPayload>> {
  return loadCloudResource(ipoCalendarCache, CACHE_KEY, () => fetchIpoCalendar(), {
    force,
    validate: validateIpoCalendar,
  });
}
