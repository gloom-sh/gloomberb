const SHARE_ID = /^[a-f0-9]{32}$/;

export function paneShareIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("share")?.trim() ?? "";
  return SHARE_ID.test(id) ? id : null;
}

export function isPaneShareHandoff(): boolean {
  const location = (globalThis as { window?: { location?: { search?: unknown } } }).window?.location;
  return typeof location?.search === "string" && paneShareIdFromSearch(location.search) !== null;
}

/**
 * The share a Gloom share link points at, or null for any other link: the
 * link Share copies and posts (`term.gloom.sh/api/shares/<id>/open`), the
 * public page (`/s/<id>`), the web app's hand-off (`/?share=<id>`) and the
 * API's own open link. Only https on Gloom's own hosts, so a look-alike on
 * another host stays an ordinary link.
 */
export function paneShareIdFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch { /* Intentional ignore: Non-URL text is not a share link. */ return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (url.hostname === "term.gloom.sh") {
    const match = /^\/(?:api\/shares\/([^/]+)\/open|s\/([^/]+))$/.exec(path);
    if (match) {
      const id = match[1] ?? match[2] ?? "";
      return SHARE_ID.test(id) ? id : null;
    }
    return path === "/" ? paneShareIdFromSearch(url.search) : null;
  }
  if (url.hostname === "api.gloom.sh") {
    const id = /^\/shares\/([^/]+)\/open$/.exec(path)?.[1] ?? "";
    return SHARE_ID.test(id) ? id : null;
  }
  return null;
}
