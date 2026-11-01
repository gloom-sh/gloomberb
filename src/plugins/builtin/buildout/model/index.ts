import { apiClient } from "../../../../api-client";
import { isShotRequestRefused } from "../../../../api-client/errors";
import { createTtlCache } from "../../../../data/ttl-cache";
import { httpFetch } from "../../../../utils/http-transport";
import { logFailure } from "../../../../utils/log-failure";
import type {
  BuildoutAccess,
  BuildoutCompaniesPayload,
  BuildoutCompany,
  BuildoutPagedState,
  RawObject,
} from "./types";
import {
  allCompaniesList,
  normalizeCompany,
  normalizeList,
  normalizeSite,
  normalizeUpdate,
} from "./normalizers";

const BUILDOUT_API_URL = "https://api.thebuildout.ai";
export const BUILDOUT_NAME = "TheBuildout";
export const PAGE_SIZE = 80;
export const LOAD_MORE_THRESHOLD = 10;

export function emptyPage<T>(loadingMore = false): BuildoutPagedState<T> {
  return {
    items: [],
    offset: 0,
    hasMore: true,
    loadingMore,
    error: null,
  };
}

function pageFromItems<T>(items: T[]): BuildoutPagedState<T> {
  return {
    items,
    offset: items.length,
    hasMore: items.length >= PAGE_SIZE,
    loadingMore: false,
    error: null,
  };
}

function buildPath(path: string, params: Record<string, string | number | boolean | null | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    query.set(key, String(value));
  }
  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export async function buildoutApi<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await httpFetch(`${BUILDOUT_API_URL}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.text().catch(() => {
      // Intentional ignore: the failed request still throws its status when the error body is unreadable.
      return "";
    });
    throw new Error(body || `${BUILDOUT_NAME} request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

async function fetchLists(token: string | null) {
  const response = await buildoutApi<RawObject[]>("/lists", token);
  const lists = Array.isArray(response) ? response.map(normalizeList) : [];
  return [allCompaniesList(), ...lists.filter((list) => list.slug !== "all")];
}

export async function fetchCompaniesPage(token: string | null, listSlug: string, offset: number) {
  const response = await buildoutApi<BuildoutCompaniesPayload>(buildPath("/companies", {
    limit: PAGE_SIZE,
    offset,
    detail: true,
    sort: "marketCap",
    order: "desc",
    list: listSlug === "all" ? null : listSlug,
  }), token);
  const rawCompanies = Array.isArray(response) ? response : response.companies ?? [];
  return {
    items: rawCompanies.map(normalizeCompany),
    blurredCompanyCount: Array.isArray(response) ? 0 : Number(response.blurredCount ?? 0),
  };
}

export async function fetchSitesPage(token: string | null, offset: number) {
  const response = await buildoutApi<RawObject[]>(buildPath("/sites", {
    limit: PAGE_SIZE,
    offset,
    detail: true,
    sort: "activityUpdatedAt",
    order: "desc",
  }), token);
  return Array.isArray(response) ? response.map(normalizeSite) : [];
}

export async function fetchIntelPage(token: string | null, offset: number) {
  const response = await buildoutApi<RawObject[]>(buildPath("/updates", {
    limit: PAGE_SIZE,
    offset,
  }), token);
  return Array.isArray(response) ? response.map(normalizeUpdate) : [];
}

export async function loadBuildoutData(token: string | null) {
  const [lists, sites, intel] = await Promise.all([
    fetchLists(token),
    fetchSitesPage(token, 0),
    fetchIntelPage(token, 0),
  ]);

  const access: BuildoutAccess = token ? "pro" : "free";

  return {
    access,
    token,
    lists,
    companies: { ...emptyPage<BuildoutCompany>(), blurredCompanyCount: 0, listSlug: null },
    sites: pageFromItems(sites),
    intel: pageFromItems(intel),
  };
}

/** What the dataset is read with: a Buildout token, or none for the free set. */
interface BuildoutGrant {
  token: string | null;
  expiresAtMs: number | null;
}

/** Whose reads these are: the signed-in account, and its token when it has Buildout. */
export interface BuildoutReader {
  account: string | null;
  token: string | null;
}

/** What a pane shows in a screenshot of an account with the plan, whose token the capture never holds. */
export const NOT_IN_SCREENSHOTS = "Not available in screenshots.";

const NO_GRANT: BuildoutGrant = { token: null, expiresAtMs: null };
/** A token is asked for again this long before it lapses. */
const TOKEN_RENEW_EARLY_MS = 60_000;
/** A token whose answer carries no expiry is kept this long. */
const TOKEN_FALLBACK_MS = 5 * 60_000;
/** An account without Buildout is asked again after this long, so a new plan shows within a minute. */
const NO_PLAN_MS = 60_000;

/**
 * One account's grant, shared by every pane and the facilities layer: asking
 * costs three account requests (one issues a token), and a linked desk asks
 * on every company the cursor passes.
 */
const grants = createTtlCache<BuildoutGrant>({
  ttlMs: (grant) => {
    if (!grant.token) return NO_PLAN_MS;
    if (grant.expiresAtMs === null) return TOKEN_FALLBACK_MS;
    return Math.max(0, grant.expiresAtMs - Date.now() - TOKEN_RENEW_EARLY_MS);
  },
  maxEntries: 4,
});

async function issueGrant(checkSession: boolean): Promise<BuildoutGrant> {
  if (checkSession && !(await apiClient.getSession())) return NO_GRANT;
  const account = await apiClient.getBuildoutAccount();
  if (!account?.subscription.active) return NO_GRANT;
  const issued = await apiClient.getBuildoutToken();
  if (!issued?.token) return NO_GRANT;
  const expiresAtMs = Date.parse(issued.expiresAt);
  return { token: issued.token, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null };
}

/**
 * The account reading the dataset and its token. A token is reused until a
 * minute before it lapses; `fresh` asks again, for a refresh the user pressed.
 * Signed out there is no account and no token, at once.
 */
export async function getBuildoutReader({ fresh = false }: { fresh?: boolean } = {}): Promise<BuildoutReader> {
  if (!apiClient.isSignedIn()) return { account: null, token: null };

  try {
    // A user restored from the last run still has its session checked before a token is issued.
    const restored = apiClient.getCurrentUser();
    const user = restored ?? await apiClient.getSession();
    if (!user) return { account: null, token: null };
    const grant = await grants.load(user.id, () => issueGrant(restored !== null), { force: fresh });
    return { account: user.id, token: grant.token };
  } catch (error) {
    // A capture's proxy never mints a plan's token: access is not unknown, the capture cannot carry it.
    if (isShotRequestRefused(error)) throw new Error(NOT_IN_SCREENSHOTS);
    logFailure("buildout.model", "Check access failed")(error);
    throw new Error("Access check failed. Access is unknown.");
  }
}

export async function getBuildoutProToken(options?: { fresh?: boolean }) {
  return (await getBuildoutReader(options)).token;
}
