import { apiClient } from "../../../../api-client";
import { httpFetch } from "../../../../utils/http-transport";
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
    const body = await response.text().catch(() => "");
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
    companies: { ...emptyPage<BuildoutCompany>(), blurredCompanyCount: 0 },
    sites: pageFromItems(sites),
    intel: pageFromItems(intel),
  };
}

export async function getBuildoutProToken() {
  if (!apiClient.isSignedIn()) return null;

  const session = await apiClient.getSession().catch(() => null);
  if (!session) return null;

  const account = await apiClient.getBuildoutAccount().catch(() => null);
  if (!account?.subscription.active) return null;

  const token = await apiClient.getBuildoutToken().catch(() => null);
  return token?.token ?? null;
}
