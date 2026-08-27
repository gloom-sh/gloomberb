import { apiClient } from "../api-client";
import { ApiRequestError } from "../api-client/errors";
import { parseSharePayload, type SharePayload } from "./payload";

declare const __GLOOMBERB_API_URL__: string | undefined;

const bundledApiOrigin = typeof __GLOOMBERB_API_URL__ === "string" ? __GLOOMBERB_API_URL__ : "";
export const SHARE_API_ORIGIN = bundledApiOrigin
  ? typeof location !== "undefined" && bundledApiOrigin === location.origin
    ? `${bundledApiOrigin}/api`
    : bundledApiOrigin
  : "https://api.gloom.sh";
export const PUBLIC_SHARE_ORIGIN = "https://term.gloom.sh";
const SHARE_ID = /^[a-f0-9]{32}$/;
type ShareFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ShareRecord = SharePayload & {
  createdAt: string;
  expiresAt: string;
  ownedByViewer: boolean;
};

export interface CreatedShare {
  id: string;
  expiresAt: string;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new Error("The share service returned an invalid response."); }
}

export async function createShare(payload: SharePayload, fetchImpl?: ShareFetch): Promise<CreatedShare> {
  const validated = parseSharePayload(payload);
  if (!validated) throw new Error("Invalid share payload.");
  let body: unknown;
  if (fetchImpl) {
    const response = await fetchImpl(`${SHARE_API_ORIGIN}/shares`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validated),
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error("Sign in to Gloom Cloud to share.");
      if (response.status === 403) throw new Error("Verify your Gloom Cloud email to share.");
      throw new Error("Could not create share.");
    }
    body = await readJson(response);
  } else {
    try {
      body = await apiClient.createTerminalShare(validated);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) throw new Error("Sign in to Gloom Cloud to share.");
      if (error instanceof ApiRequestError && error.status === 403) throw new Error("Verify your Gloom Cloud email to share.");
      throw error;
    }
  }
  if (!body || typeof body !== "object") throw new Error("The share service returned an invalid response.");
  const { id, expiresAt } = body as Record<string, unknown>;
  if (typeof id !== "string" || !SHARE_ID.test(id) || !validDate(expiresAt)) {
    throw new Error("The share service returned an invalid response.");
  }
  return { id, expiresAt };
}

export async function getShare(
  id: string,
  fetchImpl: ShareFetch = fetch,
  options?: { trackView?: boolean },
): Promise<ShareRecord | null> {
  if (!SHARE_ID.test(id)) return null;
  const purpose = options?.trackView === false ? "?purpose=open" : "";
  const response = await fetchImpl(`${SHARE_API_ORIGIN}/shares/${encodeURIComponent(id)}${purpose}`, {
    credentials: "include",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Could not load share.");
  const body = await readJson(response);
  if (!body || typeof body !== "object") return null;
  const object = body as Record<string, unknown>;
  const payload = parseSharePayload({ kind: object.kind, data: object.data });
  if (!payload || !validDate(object.createdAt) || !validDate(object.expiresAt)) return null;
  return {
    ...payload,
    createdAt: object.createdAt,
    expiresAt: object.expiresAt,
    ownedByViewer: object.ownedByViewer === true,
  };
}

export async function deleteShare(id: string, fetchImpl: ShareFetch = fetch): Promise<void> {
  if (!SHARE_ID.test(id)) throw new Error("Invalid share id.");
  const response = await fetchImpl(`${SHARE_API_ORIGIN}/shares/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (response.status !== 204) {
    throw new Error(response.status === 401 || response.status === 403
      ? "Only the signed-in owner can delete this share."
      : "Could not delete share.");
  }
}

export function publicShareUrl(id: string, origin = PUBLIC_SHARE_ORIGIN): string {
  if (!SHARE_ID.test(id)) throw new Error("Invalid share id.");
  return new URL(`/s/${encodeURIComponent(id)}`, origin).toString();
}

export function openLiveShareUrl(id: string, origin = PUBLIC_SHARE_ORIGIN): string {
  if (!SHARE_ID.test(id)) throw new Error("Invalid share id.");
  return new URL(`/api/shares/${encodeURIComponent(id)}/open`, origin).toString();
}

export function parseShareId(pathname: string): string | null {
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1] ?? "");
    return SHARE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}
