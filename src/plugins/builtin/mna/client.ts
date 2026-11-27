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
import { isNonNegativeInt, isNullableFinite, isNullableString } from "../../../utils/guards";
import { createCloudEndpoint, type CloudResource } from "../shared/cloud-resource";

const UNAVAILABLE = "M&A deals are not available on this server yet.";
const STATUSES = new Set(["talks", "pending", "completed", "terminated"]);
const CONSIDERATIONS = new Set(["cash", "stock", "mixed", "undisclosed"]);
const EVENT_KINDS = new Set([
  "talks", "announced", "amended", "filing", "tender", "vote", "regulatory", "completed", "terminated", "update",
]);

const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string";

function validParty(party: MnaParty | null | undefined): boolean {
  return !!party && text(party.name) && party.name.length > 0 && isNullableString(party.symbol) && isNullableString(party.country);
}

function validDeal(deal: MnaDeal): boolean {
  const terms = deal?.terms;
  return !!deal
    && text(deal.id) && deal.id.length > 0
    && validParty(deal.target)
    && (deal.acquirer === null || validParty(deal.acquirer))
    && STATUSES.has(deal.status)
    && isNullableString(deal.stage)
    && typeof deal.hostile === "boolean"
    && !!terms && CONSIDERATIONS.has(terms.consideration)
    && isNullableFinite(terms.cashPerShare) && isNullableFinite(terms.exchangeRatio)
    && isNullableString(terms.ratioSymbol) && isNullableString(terms.currency)
    && (terms.election === undefined || typeof terms.election === "boolean")
    && typeof terms.cvr === "boolean" && typeof terms.partial === "boolean"
    && isNullableFinite(deal.value) && isNullableString(deal.valueCurrency) && isNullableFinite(deal.valueUsd)
    && day(deal.announced)
    && isNullableString(deal.expectedClose)
    && (deal.closed === null || day(deal.closed))
    && text(deal.headline)
    && text(deal.updatedAt)
    && day(deal.lastReported)
    && typeof deal.stale === "boolean";
}

function validEvent(event: MnaDealEvent): boolean {
  return !!event && text(event.id) && day(event.date) && EVENT_KINDS.has(event.kind)
    && text(event.title) && text(event.source) && isNullableString(event.url);
}

function validateMnaDeals(data: MnaDealsPayload): MnaDealsPayload {
  const valid = !!data
    && Array.isArray(data.deals) && data.deals.every(validDeal)
    && typeof data.hasMore === "boolean"
    && isNonNegativeInt(data.nextOffset)
    && (data.access === "full" || data.access === "delayed")
    && isNonNegativeInt(data.delayDays)
    && isNonNegativeInt(data.lockedDeals)
    && text(data.asOf);
  if (!valid) throw new Error("The server returned an unreadable deal list");
  return data;
}

function validateMnaDeal(data: MnaDealPayload): MnaDealPayload {
  const valid = !!data
    && validDeal(data.deal)
    && Array.isArray(data.events) && data.events.every(validEvent)
    && (data.access === "full" || data.access === "delayed");
  if (!valid) throw new Error("The server returned an unreadable deal");
  return data;
}

// Deals change when a story or a filing lands, a few times an hour at most, so a list stays fresh for five minutes.
// The plan is part of every key: a delayed list and the full one are different answers.
const mnaDealsEndpoint = createCloudEndpoint<{ params: MnaDealsParams; pro?: boolean }, MnaDealsPayload, Pick<HeadlessPaneApiClient, "getCloudMnaDeals">>({
  kind: "mna-deals", schemaVersion: 2, policy: { staleMs: 5 * 60_000, expireMs: 7 * 86_400_000 },
  key: ({ params, pro }) => JSON.stringify([params.status ?? "pending", params.target ?? "all", params.region ?? "all",
    params.symbol?.toUpperCase() ?? "", params.query?.trim().toLowerCase() ?? "", params.offset ?? 0, pro ? "full" : "delayed"]),
  defaultClient: apiClient, fetch: ({ params }, client, signal) => client.getCloudMnaDeals(params, { signal }),
  validate: validateMnaDeals, unavailableMessage: UNAVAILABLE,
});
const mnaDealEndpoint = createCloudEndpoint<{ id: string; pro?: boolean }, MnaDealPayload, Pick<HeadlessPaneApiClient, "getCloudMnaDeal">>({
  kind: "mna-deal", schemaVersion: 2, policy: { staleMs: 5 * 60_000, expireMs: 30 * 86_400_000 },
  key: ({ id, pro }) => `${id}:${pro ? "full" : "delayed"}`,
  defaultClient: apiClient, fetch: ({ id }, client) => client.getCloudMnaDeal(id), validate: validateMnaDeal,
});

export const mnaDealsCache = mnaDealsEndpoint.cache;
export const mnaDealCache = mnaDealEndpoint.cache;
export const fetchMnaDeals = (params: MnaDealsParams, client: Pick<HeadlessPaneApiClient, "getCloudMnaDeals"> = apiClient, signal?: AbortSignal) =>
  mnaDealsEndpoint.fetch({ params }, { client, signal });
export const cachedMnaDeals = (params: MnaDealsParams, pro: boolean) => mnaDealsEndpoint.cached({ params, pro });
export const loadMnaDeals = (params: MnaDealsParams, pro: boolean, force = false): Promise<CloudResource<MnaDealsPayload>> =>
  mnaDealsEndpoint.load({ params, pro }, { force });
export const cachedMnaDeal = (id: string, pro: boolean) => mnaDealEndpoint.cached({ id, pro });
export const loadMnaDeal = (id: string, pro: boolean, force = false): Promise<CloudResource<MnaDealPayload>> =>
  mnaDealEndpoint.load({ id, pro }, { force });

/** Appends a page by id; a deal that moved between pages keeps its first place. */
export function appendMnaDeals(current: MnaDealsPayload, page: MnaDealsPayload): MnaDealsPayload {
  const seen = new Set(current.deals.map((deal) => deal.id));
  return {
    ...page,
    deals: [...current.deals, ...page.deals.filter((deal) => !seen.has(deal.id))],
  };
}
