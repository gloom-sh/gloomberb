import { expect, test } from "bun:test";
import type { PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createTestTicker } from "../../test-support/ticker";
import { ProviderBusyError } from "../../sources/provider-errors";
import { DataServiceUnreachableError } from "../../utils/network-failure";
import type { TickerRecord } from "../../types/ticker";
import { search } from "./search";

/**
 * A rate-limited catalogue printed "No matches found." and exited 0, which
 * reads as "this company does not exist" (Eagle Bulk, 2026-10-18), and so did
 * a search offline or through a proxy that never answered.
 */
test("a search the data service was too busy for or never answered fails, unlike a search that found nothing", async () => {
  const run = async (answer: () => Promise<never[]>, tickers: TickerRecord[] = []) => {
    const dataProvider = createTestDataProvider({ search: answer });
    const initMarketData = async () => ({ store: { loadAllTickers: async () => tickers }, dataProvider, persistence: { close() {} } }) as never;
    const printed: PrintedCliResult["result"][] = [];
    const failure = await search("Eagle Bulk", { initMarketData, printResult: (result) => { printed.push(result); } }).then(() => null, (error: unknown) => error);
    return { failure, printed };
  };
  const busy = async () => { throw new ProviderBusyError(); };

  const unanswered = await run(busy);
  expect(unanswered.failure).toMatchObject({ code: "search_busy", retryable: true });
  expect(unanswered.printed).toEqual([]);

  // No answer at all: the command fails as any command offline does, "couldn't reach", exit 1.
  const offline = await run(async () => { throw new DataServiceUnreachableError(new TypeError("Failed to fetch")); });
  expect(offline.failure).toBeInstanceOf(DataServiceUnreachableError);
  expect(offline.printed).toEqual([]);

  // Nothing found is an answer: an empty list and the catalog hint, no failure.
  const empty = await run(async () => []);
  expect(empty.failure).toBeNull();
  expect(empty.printed[0]!.data).toEqual([]);

  // A saved ticker that matches still answers while the service is busy.
  const partial = await run(busy, [createTestTicker("EGLE", "Eagle Bulk Shipping Inc.")]);
  expect(partial.failure).toBeNull();
  expect((partial.printed[0]!.data as Array<{ symbol: string }>).map((row) => row.symbol)).toEqual(["EGLE"]);
});

/**
 * "baltic dry" printed only "Search is busy" about half the time: the gap line
 * and its proxies are the answer, and they need no lookup.
 */
test("a busy or unreachable ticker lookup still prints the freight gap line first, then fails for the tickers alone", async () => {
  const run = async (answer: () => Promise<never[]>, json: boolean) => {
    const dataProvider = createTestDataProvider({ search: answer });
    const initMarketData = async () => ({ store: { loadAllTickers: async () => [] }, dataProvider, persistence: { close() {} } }) as never;
    const logged: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => { logged.push(String(line)); };
    try {
      const failure = await search("baltic dry", { initMarketData, ...json ? { printResult: () => {} } : {} })
        .then(() => null, (error: unknown) => error as { code: string; message: string; details?: string; retryable?: boolean });
      return { failure, logged: logged.join("\n") };
    } finally {
      console.log = log;
    }
  };
  const busy = async () => { throw new ProviderBusyError(); };
  const text = await run(busy, false);
  expect(text.logged).toContain("Baltic indices (BDI, Capesize, Panamax, Supramax) and freight forwards (FFA) are not covered.");
  expect(text.failure).toMatchObject({ code: "search_busy", message: "Ticker search is busy, try again in a moment.", retryable: true });
  // JSON has one document: the failure carries the line.
  const json = await run(busy, true);
  expect(json.logged).toBe("");
  expect(json.failure?.details).toContain("Traded proxies: BDRY");
  const offline = await run(async () => { throw new DataServiceUnreachableError(new TypeError("Failed to fetch")); }, false);
  expect(offline.logged).toContain("fn CHOKE");
  expect(offline.failure).toMatchObject({ code: "service_unreachable", retryable: true });
});

test("a name typed in kana or kanji is searched as typed, matches no saved ticker, and says what to type when nothing lists it", async () => {
  const saved = ["AAPL", "AMC", "AMZN", "BRK.B", "BTC-USD"].map((symbol) => createTestTicker(symbol, symbol));
  const run = async (query: string, answer: (query: string) => Promise<never[]>) => {
    const asked: string[] = [];
    const dataProvider = createTestDataProvider({ search: async (query: string) => { asked.push(query); return answer(query); } });
    const initMarketData = async () => ({ store: { loadAllTickers: async () => saved }, dataProvider, persistence: { close() {} } }) as never;
    const printed: PrintedCliResult["result"][] = [];
    const failure = await search(query, { initMarketData, printResult: (result) => { printed.push(result); } }).then(() => null, (error: unknown) => error);
    return { asked, failure, printed: printed[0] };
  };
  // The service fails on every name in another script; that is no busy search, and the saved list is no match.
  for (const query of ["ゲームストップ", "任天堂"]) {
    const { asked, failure, printed } = await run(query, async () => { throw new ProviderBusyError(); });
    expect(asked).toContain(query);
    expect(failure).toBeNull();
    expect(printed!.data).toEqual([]);
    expect(printed!.warnings).toEqual(["No matches. Try the ticker or the English name."]);
  }
  // A Latin name the service is too busy for is still busy.
  expect((await run("gamestop", async () => { throw new ProviderBusyError(); })).failure).toMatchObject({ code: "search_busy" });
});

/**
 * `search cassava` against production, 2026-10-25: the service answered with Filana Therapeutics' FLNA first,
 * carrying the name it had, but the list put it last under Other Listings, behind the German lines that still
 * list Cassava Sciences, and the name was nowhere on it.
 */
test("a company found by the name it had before it was renamed leads, and says what it was called", async () => {
  const row = (symbol: string, name: string, exchange: string, extra: Record<string, unknown> = {}) =>
    ({ providerId: "gloomberb-cloud", symbol, name, exchange, type: "EQUITY", primaryExchange: exchange, ...extra });
  const answer = [
    row("FLNA", "Filana Therapeutics, Inc.", "NASDAQ", { type: "Common Stock", currency: "USD", searchAliases: ["CASSAVA SCIENCES INC"], formerName: "Cassava Sciences Inc" }),
    row("PX91.MU", "Cassava Sciences Inc", "MUNICH", { popularity: 20010 }),
    row("PX91.DU", "Cassava Sciences Inc", "XDUS", { popularity: 20005 }),
    row("0841", "Asia Cassava Resources Holdings Limited", "HKEX", { popularity: 20001 }),
  ];
  const dataProvider = createTestDataProvider({ search: async () => answer as never });
  const initMarketData = async () => ({ store: { loadAllTickers: async () => [] }, dataProvider, persistence: { close() {} } }) as never;
  const printed: PrintedCliResult["result"][] = [];
  await search("cassava", { initMarketData, printResult: (result) => { printed.push(result); } });
  const rows = printed[0]!.data as Array<{ category: string; symbol: string; formerName?: string }>;
  // Other Listings are Filana's own lines, under the name it had; another company's 0841 is an Other Match.
  expect(rows.map((item) => `${item.symbol}:${item.category}`)).toEqual([
    "FLNA:Primary Listing", "PX91.MU:Other Listings", "PX91.DU:Other Listings", "0841:Other Matches",
  ]);
  expect(rows[0]!.formerName).toBe("Cassava Sciences Inc");
  expect("formerName" in rows[1]!).toBe(false);
  expect(printed[0]!.warnings).toEqual(["FLNA is Filana Therapeutics, Inc., formerly Cassava Sciences Inc"]);
});

/**
 * `search DK` on 30 Oct 2026 listed DKC1O, DKIMA and DKC1D, unnamed, and Daiei Kankyo's DKCLF under Delek's
 * Other Listings.
 */
test("Other Listings keep the primary listing's company's lines, its nameless ones included; another company's or another symbol's unnamed line is an Other Match", async () => {
  const row = (symbol: string, name: string, exchange: string) => ({ providerId: "gloomberb-cloud", symbol, name, exchange, type: "Common Stock", primaryExchange: exchange });
  const answer = [
    row("DK", "Delek US Holdings, Inc.", "NYSE"), row("DK", "Delek US Holdings, Inc.", "IEX"), row("DKC1O", "DKC1O", "BYMA"),
    // Delek's own line on another venue, which search names no company for.
    { ...row("DK", "", "BYMA"), primaryExchange: "NYSE" },
    row("DKIMA", "DKIMA", "SFB"), row("DKCLF", "Daiei Kankyo Co., Ltd.", "OTC"), row("DKL", "Delek Logistics Partners, LP", "NYSE"),
  ];
  const dataProvider = createTestDataProvider({ search: async () => answer as never, getQuote: async () => { throw new Error("no quote"); } });
  const initMarketData = async () => ({ store: { loadAllTickers: async () => [] }, dataProvider, persistence: { close() {} } }) as never;
  const printed: PrintedCliResult["result"][] = [];
  await search("DK", { initMarketData, printResult: (result) => { printed.push(result); } });
  const rows = printed[0]!.data as Array<{ category: string; symbol: string; exchange: string }>;
  expect(rows.map((item) => `${item.symbol}:${item.exchange}:${item.category}`)).toEqual([
    "DK:NYSE:Primary Listing", "DK:IEX:Other Listings", "DK:BYMA:Other Listings",
    "DKC1O:BYMA:Other Matches", "DKIMA:SFB:Other Matches", "DKCLF:OTC:Other Matches", "DKL:NYSE:Other Matches",
  ]);
});
