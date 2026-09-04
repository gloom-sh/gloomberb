export function researchEntryFromSearch(search: string): { symbol: string; tab: string } | null {
  const params = new URLSearchParams(search);
  const symbol = params.get("ticker")?.trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9.^=:_-]{1,24}$/.test(symbol)) return null;
  const tab = params.get("tab") ?? "overview";
  return { symbol, tab: /^[a-z-]{1,40}$/.test(tab) ? tab : "overview" };
}
