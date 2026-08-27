import {
  PUBLIC_SHARE_ORIGIN,
  SHARE_API_ORIGIN,
} from "../shares/api";
import {
  isMarketplaceLayoutId,
  parseMarketplaceLayoutEntry,
  type LayoutMarketplaceEntry,
} from "./payload";

type LayoutFetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function getPublicMarketplaceLayout(
  id: string,
  fetchImpl: LayoutFetch = fetch,
): Promise<LayoutMarketplaceEntry | null> {
  if (!isMarketplaceLayoutId(id)) return null;
  const response = await fetchImpl(
    `${SHARE_API_ORIGIN}/layouts/${encodeURIComponent(id)}`,
    { credentials: "include" },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Could not load shared layout.");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("The layout service returned an invalid response.");
  }
  return parseMarketplaceLayoutEntry(body);
}

export function publicMarketplaceLayoutUrl(
  id: string,
  origin = PUBLIC_SHARE_ORIGIN,
): string {
  if (!isMarketplaceLayoutId(id)) throw new Error("Invalid layout id.");
  return new URL(`/l/${encodeURIComponent(id)}`, origin).toString();
}

export function openLiveMarketplaceLayoutUrl(
  id: string,
  origin = PUBLIC_SHARE_ORIGIN,
): string {
  if (!isMarketplaceLayoutId(id)) throw new Error("Invalid layout id.");
  const url = new URL("/", origin);
  url.searchParams.set("layout", id);
  return url.toString();
}

export function marketplaceLayoutIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("layout")?.trim() ?? "";
  return isMarketplaceLayoutId(id) ? id : null;
}

export function parseMarketplaceLayoutId(pathname: string): string | null {
  const match = /^\/l\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1] ?? "");
    return isMarketplaceLayoutId(id) ? id : null;
  } catch {
    return null;
  }
}
