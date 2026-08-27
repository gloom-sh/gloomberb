const SHARE_ID = /^[a-f0-9]{32}$/;

export function paneShareIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("share")?.trim() ?? "";
  return SHARE_ID.test(id) ? id : null;
}

export function isPaneShareHandoff(): boolean {
  const location = (globalThis as { window?: { location?: { search?: unknown } } }).window?.location;
  return typeof location?.search === "string" && paneShareIdFromSearch(location.search) !== null;
}
