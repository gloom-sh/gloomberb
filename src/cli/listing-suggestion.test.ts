import { expect, test } from "bun:test";
import type { TickerSearchCandidate } from "../tickers/search";
import type { TickerRecord } from "../types/ticker";
import { describeSuggestion, MAX_SUGGESTED_SYMBOLS, nearestListing, suggestListing, suggestListings, suggestUsTicker, withSuggestion } from "./listing-suggestion";
import { TickerNotFoundError } from "./ticker-resolution";

/** A row as `search` lists it: the symbol, then the name before its provider and type. */
function hit(symbol: string, name: string, extra: Partial<TickerSearchCandidate> = {}): TickerSearchCandidate {
  return {
    id: `search:${symbol}`, label: symbol, symbol, detail: `${name} | Test`, kind: "search", category: "Primary Listing",
    saved: false, instrumentClass: "other", searchAliases: [], ...extra,
  };
}

const NGN = hit("USDNGN=X", "US Dollar/Nigerian Naira");
const deps = (search: (query: string) => Promise<TickerSearchCandidate[]>, timeoutMs?: number) => ({
  store: { loadAllTickers: async () => [] },
  dataProvider: {} as never,
  search,
  timeoutMs,
});

test("only a near match is suggested: the same symbol with other punctuation, or one slip, never a first result for being first", () => {
  // USD-NGN is USDNGN=X without its pair suffix and with a dash; the name spelled USD/NGN says the same.
  expect(nearestListing("USD-NGN", [NGN])).toEqual({ symbol: "USDNGN=X", name: "US Dollar/Nigerian Naira" });
  expect(nearestListing("usd/ngn", [hit("USDNGN=X", "USD/NGN")])).toEqual({ symbol: "USDNGN=X", name: "USD/NGN" });
  expect(nearestListing("GSPC", [hit("^GSPC", "S&P 500")])).toEqual({ symbol: "^GSPC", name: "S&P 500" });
  expect(nearestListing("NVDIA", [hit("NVDA", "NVIDIA Corp")])).toEqual({ symbol: "NVDA", name: "NVIDIA Corp" });
  expect(nearestListing("BRKB", [hit("BRK.B", "Berkshire Hathaway B")])?.symbol).toBe("BRK.B");

  // The first hit is not taken because it is first: the near one further down is.
  expect(nearestListing("USD-NGN", [hit("NGNX", "Something else"), hit("USDZAR=X", "US Dollar/South African Rand"), NGN])?.symbol).toBe("USDNGN=X");
  // Nothing near: a loose or unrelated hit, a symbol too short for one slip, a hit that is the typed symbol itself.
  expect(nearestListing("USD-NGN", [hit("USDZAR=X", "US Dollar/South African Rand"), hit("NGN", "Nigeria ETF")])).toBeNull();
  expect(nearestListing("FAKE", [hit("FAK", "Fak Corp"), hit("FAKEX", "Fake Co")])?.symbol).toBe("FAKEX");
  expect(nearestListing("XYZ", [hit("XYZA", "Xyza"), hit("XY", "Xy")])).toBeNull();
  expect(nearestListing("USDNGN=X", [NGN])).toBeNull();
  expect(nearestListing("USD-NGN", [])).toBeNull();
  // A tie between different symbols is no suggestion; the same symbol on several venues is one.
  expect(nearestListing("ABCD1", [hit("ABCD", "A"), hit("ABC1D", "B")])).toBeNull();
  expect(nearestListing("USD-NGN", [NGN, hit("USDNGN=X", "US Dollar/Nigerian Naira", { id: "search:other" })])?.symbol).toBe("USDNGN=X");
});

test("the suggestion reads as `search` names the listing, and the name is left out when it only repeats the symbol", () => {
  expect(describeSuggestion({ symbol: "USDNGN=X", name: "US Dollar/Nigerian Naira" })).toBe("USDNGN=X (US Dollar/Nigerian Naira)");
  expect(describeSuggestion({ symbol: "NVDA", name: "" })).toBe("NVDA");
  expect(describeSuggestion({ symbol: "NVDA", name: "nvda" })).toBe("NVDA");
});

test("a search that fails, finds nothing or never answers leaves no suggestion and never throws or hangs", async () => {
  expect(await suggestListing("USD-NGN", deps(async () => [NGN]))).toEqual({ symbol: "USDNGN=X", name: "US Dollar/Nigerian Naira" });
  expect(await suggestListing("USD-NGN", deps(async () => []))).toBeNull();
  expect(await suggestListing("USD-NGN", deps(async () => { throw new Error("Gloom Cloud refused the request"); }))).toBeNull();
  expect(await suggestListing("USD-NGN", deps(() => { throw new Error("thrown before a promise"); }))).toBeNull();
  const started = Date.now();
  expect(await suggestListing("USD-NGN", deps(() => new Promise<TickerSearchCandidate[]>(() => {}), 20))).toBeNull();
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(await suggestListing("   ", deps(async () => [NGN]))).toBeNull();
});

test("the search is asked for what was typed, without a leading dollar sign", async () => {
  const asked: string[] = [];
  await suggestListing(" $USD-NGN ", deps(async (query) => { asked.push(query); return [NGN]; }));
  expect(asked).toEqual(["USD-NGN"]);
});

test("a single symbol's plain no-match error gains the suggestion, and every other error comes back as it was", async () => {
  const plain = new TickerNotFoundError('No ticker match found for "USD-NGN".');
  const suggested = await withSuggestion(plain, "USD-NGN", deps(async () => [NGN]));
  expect(suggested).toBeInstanceOf(TickerNotFoundError);
  expect((suggested as Error).message).toBe('No ticker match found for "USD-NGN"; did you mean USDNGN=X (US Dollar/Nigerian Naira)?');
  expect(await withSuggestion(plain, "USD-NGN", deps(async () => []))).toBe(plain);
  // A symbol that changed or stopped trading already says why.
  const changed = new TickerNotFoundError('No ticker match found for "TRCH". TRCH became MMAT on 2021-07-06.');
  expect(await withSuggestion(changed, "TRCH", deps(async () => [hit("MMAT", "Meta Materials")]))).toBe(changed);
  const other = new Error("Gloom Cloud did not answer.");
  expect(await withSuggestion(other, "USD-NGN", deps(async () => [NGN]))).toBe(other);
});

test("a long list of missing symbols is a stale import, not typos, and costs no search", async () => {
  let searches = 0;
  const search = async () => { searches += 1; return [NGN]; };
  const few = Array.from({ length: MAX_SUGGESTED_SYMBOLS }, (_, index) => `USD-NGN${index}`);
  expect((await suggestListings(few, deps(search))).length).toBe(MAX_SUGGESTED_SYMBOLS);
  expect(searches).toBe(MAX_SUGGESTED_SYMBOLS);
  searches = 0;
  expect((await suggestListings([...few, "USD-NGN"], deps(search))).every((suggestion) => suggestion === null)).toBe(true);
  expect(searches).toBe(0);
});

test("a symbol read abroad is a typo for the one US ticker a person likely means, which search then names", async () => {
  const us = (symbol: string, name: string, exchangeLabel = "NASDAQ") => hit(symbol, name, { exchangeLabel });
  const search = async (query: string) => query === "AAPL"
    ? [us("AAPL", "Apple Inc.", "BVC"), us("AAPL", "Apple Inc.")]
    : [];
  // APPL is Aptus Pharma on BSE; search lists no AAPL for it, so the match comes from the symbols people mean.
  expect(await suggestUsTicker("APPL", deps(search))).toEqual({ symbol: "AAPL", name: "Apple Inc." });
  expect(await suggestUsTicker("appl", deps(search))).toEqual({ symbol: "AAPL", name: "Apple Inc." });
  // A swap of neighbours is one slip too; a symbol that is not near any, and one too short, are not suggested.
  expect(await suggestUsTicker("MSTF", deps(async () => [us("MSFT", "Microsoft Corporation")]))).toEqual({ symbol: "MSFT", name: "Microsoft Corporation" });
  expect(await suggestUsTicker("SXR8", deps(search))).toBeNull();
  expect(await suggestUsTicker("AAL", deps(search))).toBeNull();

  // The tickers a person saved count when they are US listings; a saved listing abroad does not.
  const saved = (ticker: string, exchange: string) => ({ metadata: { ticker, exchange } }) as TickerRecord;
  const withSaved = (...records: TickerRecord[]) => ({ ...deps(async () => [us("ZYGO", "Zygo Corp")]), store: { loadAllTickers: async () => records } });
  expect(await suggestUsTicker("ZYGP", withSaved(saved("ZYGO", "NASDAQ")))).toEqual({ symbol: "ZYGO", name: "Zygo Corp" });
  expect(await suggestUsTicker("ZYGP", withSaved(saved("ZYGO", "XETRA")))).toBeNull();
  // Two US symbols one slip away is a tie, not a guess.
  expect(await suggestUsTicker("TSLB", withSaved(saved("TSLC", "NYSE")))).toBeNull();

  // Search finding no US listing for the near symbol drops the suggestion; a search that fails keeps the symbol, unnamed.
  expect(await suggestUsTicker("APPL", deps(async () => [us("AAPL", "Apple Inc.", "BVC")]))).toBeNull();
  expect(await suggestUsTicker("APPL", deps(async () => { throw new Error("down"); }))).toEqual({ symbol: "AAPL", name: "" });
});
