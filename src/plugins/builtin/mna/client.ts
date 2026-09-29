import { apiClient } from "../../../api-client";
import type {
  MnaDeal,
  MnaDealEvent,
  MnaDealPayload,
  MnaDealsParams,
  MnaDealsPayload,
  MnaParty,
} from "../../../api-client/mna";
import type { HeadlessPaneApiClient } from "../../../types/plugin";
import { createPluginCache } from "../../../data/plugin-cache";
import { loadCloudResource, unavailableOnServer, type CloudResource } from "../shared/cloud-resource";

/**
 * Deals change when a story or a filing lands, a few times an hour at most,
 * so a list stays fresh for five minutes. The plan is part of every key: a
 * delayed list and the full one are different answers.
 */
export const mnaDealsCache = createPluginCache<MnaDealsPayload>({
  kind: "mna-deals",
  source: "gloom-cloud",
  schemaVersion: 2,
  policy: { staleMs: 5 * 60_000, expireMs: 7 * 86_400_000 },
});

export const mnaDealCache = createPluginCache<MnaDealPayload>({
  kind: "mna-deal",
  source: "gloom-cloud",
  schemaVersion: 2,
  policy: { staleMs: 5 * 60_000, expireMs: 30 * 86_400_000 },
});

const UNAVAILABLE = "M&A deals are not available on this server yet.";
const STATUSES = new Set(["talks", "pending", "completed", "terminated"]);
const CONSIDERATIONS = new Set(["cash", "stock", "mixed", "undisclosed"]);
const EVENT_KINDS = new Set([
  "talks", "announced", "amended", "filing", "tender", "vote", "regulatory", "completed", "terminated", "update",
]);

const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string";
const textOrNull = (value: unknown) => value === null || typeof value === "string";
const numberOrNull = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));

function validParty(party: MnaParty | null | undefined): boolean {
  return !!party && text(party.name) && party.name.length > 0 && textOrNull(party.symbol) && textOrNull(party.country);
}

function validDeal(deal: MnaDeal): boolean {
  const terms = deal?.terms;
  return !!deal
    && text(deal.id) && deal.id.length > 0
    && validParty(deal.target)
    && (deal.acquirer === null || validParty(deal.acquirer))
    && STATUSES.has(deal.status)
    && textOrNull(deal.stage)
    && typeof deal.hostile === "boolean"
    && !!terms && CONSIDERATIONS.has(terms.consideration)
    && numberOrNull(terms.cashPerShare) && numberOrNull(terms.exchangeRatio)
    && textOrNull(terms.ratioSymbol) && textOrNull(terms.currency)
    && typeof terms.cvr === "boolean" && typeof terms.partial === "boolean"
    && numberOrNull(deal.value) && textOrNull(deal.valueCurrency) && numberOrNull(deal.valueUsd)
    && day(deal.announced)
    && textOrNull(deal.expectedClose)
    && (deal.closed === null || day(deal.closed))
    && text(deal.headline)
    && text(deal.updatedAt)
    && day(deal.lastReported)
    && typeof deal.stale === "boolean";
}

function validEvent(event: MnaDealEvent): boolean {
  return !!event && text(event.id) && day(event.date) && EVENT_KINDS.has(event.kind)
    && text(event.title) && text(event.source) && textOrNull(event.url);
}

export function validateMnaDeals(data: MnaDealsPayload): MnaDealsPayload {
  const valid = !!data
    && Array.isArray(data.deals) && data.deals.every(validDeal)
    && typeof data.hasMore === "boolean"
    && Number.isInteger(data.nextOffset) && data.nextOffset >= 0
    && (data.access === "full" || data.access === "delayed")
    && Number.isInteger(data.delayDays) && data.delayDays >= 0
    && Number.isInteger(data.lockedDeals) && data.lockedDeals >= 0
    && text(data.asOf);
  if (!valid) throw new Error("The server returned an unreadable deal list");
  return data;
}

export function validateMnaDeal(data: MnaDealPayload): MnaDealPayload {
  const valid = !!data
    && validDeal(data.deal)
    && Array.isArray(data.events) && data.events.every(validEvent)
    && (data.access === "full" || data.access === "delayed");
  if (!valid) throw new Error("The server returned an unreadable deal");
  return data;
}

export async function fetchMnaDeals(
  params: MnaDealsParams,
  client: Pick<HeadlessPaneApiClient, "getCloudMnaDeals"> = apiClient,
  signal?: AbortSignal,
): Promise<MnaDealsPayload> {
  try {
    return validateMnaDeals(await client.getCloudMnaDeals(params, { signal }));
  } catch (error) {
    throw unavailableOnServer(error, UNAVAILABLE);
  }
}

export async function fetchMnaDeal(
  id: string,
  client: Pick<HeadlessPaneApiClient, "getCloudMnaDeal"> = apiClient,
): Promise<MnaDealPayload> {
  return validateMnaDeal(await client.getCloudMnaDeal(id));
}

const listKey = (params: MnaDealsParams, pro: boolean) =>
  JSON.stringify([params.status ?? "pending", params.target ?? "all", params.region ?? "all",
    params.symbol?.toUpperCase() ?? "", params.query?.trim().toLowerCase() ?? "", params.offset ?? 0, pro ? "full" : "delayed"]);

export function loadMnaDeals(params: MnaDealsParams, pro: boolean, force = false): Promise<CloudResource<MnaDealsPayload>> {
  return loadCloudResource(mnaDealsCache, listKey(params, pro), () => fetchMnaDeals(params), {
    force,
    validate: validateMnaDeals,
  });
}

export function loadMnaDeal(id: string, pro: boolean, force = false): Promise<CloudResource<MnaDealPayload>> {
  return loadCloudResource(mnaDealCache, `${id}:${pro ? "full" : "delayed"}`, () => fetchMnaDeal(id), {
    force,
    validate: validateMnaDeal,
  });
}

/** Appends a page by id; a deal that moved between pages keeps its first place. */
export function appendMnaDeals(current: MnaDealsPayload, page: MnaDealsPayload): MnaDealsPayload {
  const seen = new Set(current.deals.map((deal) => deal.id));
  return {
    ...page,
    deals: [...current.deals, ...page.deals.filter((deal) => !seen.has(deal.id))],
  };
}
