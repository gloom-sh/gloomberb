import { expect, test } from "bun:test";
import type { PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createTestTicker } from "../../test-support/ticker";
import { ProviderBusyError } from "../../sources/provider-errors";
import { DataServiceUnreachableError } from "../../utils/network-failure";
import type { TickerRecord } from "../../types/ticker";
import { quotableSearchSymbol, search } from "./search";

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
  for (const query of ["ゲームストップ", "架空商事"]) {
    const { asked, failure, printed } = await run(query, async () => { throw new ProviderBusyError(); });
    expect(asked).toContain(query);
    expect(failure).toBeNull();
    expect(printed!.data).toEqual([]);
    expect(printed!.warnings).toEqual(["No matches. Try the ticker or the English name."]);
  }
  // A Tokyo company's name in kanji is the service's to read first; one it finds nothing for is its Tokyo listing,
  // searched by its code.
  const nintendo = await run("任天堂", async () => []);
  expect(nintendo.asked.slice(0, 1)).toEqual(["任天堂"]);
  expect(nintendo.asked).toContain("7974:JPX");
  expect(nintendo.printed!.warnings![0]).toBe('Read "任天堂" as 7974:JPX.');
  // A Latin name the service is too busy for is still busy.
  expect((await run("gamestop", async () => { throw new ProviderBusyError(); })).failure).toMatchObject({ code: "search_busy" });
});

test("a fund's name that finds nothing says to try fewer words, as a fund can order them otherwise", async () => {
  const dataProvider = createTestDataProvider({ search: async () => [] });
  const initMarketData = async () => ({ store: { loadAllTickers: async () => [] }, dataProvider, persistence: { close() {} } }) as never;
  const warnings = async (query: string) => {
    const printed: PrintedCliResult["result"][] = [];
    await search(query, { initMarketData, printResult: (result) => { printed.push(result); } });
    return printed[0]!.warnings;
  };
  expect(await warnings("Nippon India Nifty IT ETF")).toEqual([
    'A fund\'s name can put its words in another order. Try fewer words: gloom search "Nippon India ETF"',
  ]);
  // Any other name keeps the catalog hint.
  expect(await warnings("Nippon India Nifty")).toEqual(['Search finds tickers and company names. Try: gloom catalog "Nippon India Nifty"']);
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
    "FLNA:Primary Listing", "PX91.MU:Other Listings", "PX91.DU:Other Listings", "0841:HKEX:Other Matches",
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

/**
 * `search DTG`, 12 Nov 2026: DTE Energy's 4.375% debentures led as the primary listing, the line the bare symbol's quote
 * read, over Daimler Truck's home line on Xetra, and a long list of Daimler's venues must not cut DTE's line.
 */
test("a debt line the bare symbol's quote reads gives way to another company's home common share, and still lists", async () => {
  const row = (exchange: string, extra: Record<string, unknown> = {}) =>
    ({ providerId: "gloomberb-cloud", symbol: "DTG", name: "Daimler Truck Holding AG", exchange, type: "Common Stock", primaryExchange: exchange, ...extra });
  const debenture = { ...row("NYSE"), name: "DTE Energy Company 2021 Series E 4.375% Junior Subordinated Debentures", type: "Preferred Stock" };
  const answer = [debenture, { ...debenture, exchange: "IEX", primaryExchange: "IEX", type: "Bond" }, row("XETRA", { homeListing: true }),
    ...["VIE", "SWX", "XSTU", "FWB2", "MUNICH", "XDUS", "HANOVER", "BER"].map((exchange) => row(exchange))];
  const quote = { symbol: "DTG", name: debenture.name, price: 18, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1, listingExchangeName: "NYSE" };
  const dataProvider = createTestDataProvider({ search: async () => answer as never, getQuote: async () => quote as never });
  const initMarketData = async () => ({ store: { loadAllTickers: async () => [] }, dataProvider, persistence: { close() {} } }) as never;
  const printed: PrintedCliResult["result"][] = [];
  await search("DTG", { initMarketData, printResult: (result) => { printed.push(result); } });
  const rows = printed[0]!.data as Array<{ category: string; symbol: string; exchange: string }>;
  expect(rows[0]).toMatchObject({ exchange: "XETRA", category: "Primary Listing" });
  expect(rows.length).toBe(10);
  expect(rows.filter((item) => item.category === "Other Matches").map((item) => item.exchange)[0]).toBe("NYSE");
});

/**
 * `search DHL`, 13 Nov 2026: DHL Group's Vienna, Hanover and Toronto lines still carry the name it had, Deutsche Post
 * AG. Read by name they were another company, an Other Match, and the cut dropped DHL Group's own venues for them.
 */
test("search groups a symbol's lines by company id where both carry one, else by name, and never cuts the company's venues for its own lines", async () => {
  const dhl = "isin:DE0005552004";
  const row = (exchange: string, name: string, extra: Record<string, unknown> = {}) =>
    ({ providerId: "gloomberb-cloud", symbol: "DHL", name, exchange, type: "Common Stock", primaryExchange: exchange, ...extra });
  const answer = [
    row("VIE", "Deutsche Post AG", { companyId: dhl }), row("XETRA", "DHL Group AG", { homeListing: true, companyId: dhl }),
    ...["FWB2", "SWX", "XSTU", "MUNICH", "XDUS", "BER", "HAMBURG"].map((exchange) => row(exchange, "DHL Group AG")),
    row("HANOVER", "Deutsche Post AG"), row("NEO", "Deutsche Post AG", { type: "Depositary Receipt" }),
    // A company the service identifies otherwise, whatever its name, is another company.
    row("BSE", "DHL Group AG", { companyId: "isin:INE000000000" }),
  ];
  const quote = { symbol: "DHL", name: "DHL Group AG", price: 60.84, change: 0, changePercent: 0, currency: "EUR", lastUpdated: 1, listingExchangeName: "XETRA" };
  const dataProvider = createTestDataProvider({ search: async () => answer as never, getQuote: async () => quote as never });
  const initMarketData = async () => ({ store: { loadAllTickers: async () => [] }, dataProvider, persistence: { close() {} } }) as never;
  const printed: PrintedCliResult["result"][] = [];
  await search("DHL", { initMarketData, printResult: (result) => { printed.push(result); } });
  const rows = printed[0]!.data as Array<{ category: string; exchange: string }>;
  // Every Deutsche Post AG line is DHL Group's; the other company's line takes the last venue's place, and only it.
  expect(rows.map((item) => `${item.exchange}:${item.category}`)).toEqual([
    "XETRA:Primary Listing",
    ...["FWB2", "SWX", "XSTU", "MUNICH", "XDUS", "BER", "HAMBURG", "VIE"].map((exchange) => `${exchange}:Other Listings`),
    "BSE:Other Matches",
  ]);
});

/**
 * `search DHL --json`, live 13 Nov: no row carried a companyId, though the service identifies DHL's Xetra line, and the
 * Vienna, Hanover and Toronto lines, named Deutsche Post AG, were Other Matches: another company's.
 */
test("search passes the service's company id through, and keeps a company's lines named as it was with it by the names the service sends", async () => {
  const row = (exchange: string, name: string, extra: Record<string, unknown> = {}) =>
    ({ providerId: "gloomberb-cloud", symbol: "DHL", name, exchange, type: "Common Stock", primaryExchange: exchange, ...extra });
  const answer = [
    row("XETRA", "DHL Group AG", { homeListing: true, companyId: "isin:DE0005552004", searchAliases: ["DHL", "Deutsche Post AG"] }),
    row("FWB2", "DHL Group AG"), row("VIE", "Deutsche Post AG"), row("HANOVER", "Deutsche Post AG"),
    row("NEO", "Deutsche Post AG", { type: "Depositary Receipt" }),
    // Another company's DHL, which the service identifies otherwise, is another company, whatever it is named like.
    row("BSE", "DHL Express India Ltd.", { companyId: "isin:INE000000000" }),
  ];
  const quote = { symbol: "DHL", name: "DHL AG", price: 60.4, change: 0, changePercent: 0, currency: "EUR", lastUpdated: 1, listingExchangeName: "XETRA" };
  const dataProvider = createTestDataProvider({ search: async () => answer as never, getQuote: async () => quote as never });
  const initMarketData = async () => ({ store: { loadAllTickers: async () => [] }, dataProvider, persistence: { close() {} } }) as never;
  const printed: PrintedCliResult["result"][] = [];
  await search("DHL", { initMarketData, printResult: (result) => { printed.push(result); } });
  const rows = printed[0]!.data as Array<{ category: string; exchange: string; companyId?: string }>;
  expect(rows.map((item) => `${item.exchange}:${item.category}`)).toEqual([
    "XETRA:Primary Listing", "FWB2:Other Listings", "VIE:Other Listings", "HANOVER:Other Listings", "NEO:Other Listings", "BSE:Other Matches",
  ]);
  // The ids the service sent are passed through; a line it did not identify carries none rather than a guess.
  expect(rows.map((item) => item.companyId ?? null)).toEqual(["isin:DE0005552004", null, null, null, null, "isin:INE000000000"]);
});

/**
 * `search mitsubishi` once Mitsubishi Corporation's Tokyo line is named in English, 9 Nov 2026: Mitsubishi UFJ and
 * Mitsubishi Heavy Industries, whose names hold every word of "Mitsubishi Corporation", were listed as its lines.
 */
test("Other Listings leave out the lines of another business whose name only adds words to the primary's", async () => {
  const row = (symbol: string, name: string, exchange: string, extra: Record<string, unknown> = {}) =>
    ({ providerId: "gloomberb-cloud", symbol, name, exchange, type: "Common Stock", primaryExchange: exchange, ...extra });
  const answer = [
    row("8058", "Mitsubishi Corporation", "JPX", { homeListing: true }),
    row("8306", "Mitsubishi UFJ Financial Group, Inc.", "JPX", { homeListing: true }),
    row("MUFG", "Mitsubishi UFJ Financial Group, Inc.", "NYSE", { type: "American Depositary Receipt" }),
    row("7011", "Mitsubishi Heavy Industries Ltd.", "JPX", { homeListing: true }),
    row("MITT", "Mitsubishi Corporation", "VIE"),
    row("MIH", "MITSUBISHI HEAVY IND. LTD.", "HANOVER"),
  ];
  const dataProvider = createTestDataProvider({ search: async () => answer as never, getQuote: async () => { throw new Error("no quote"); } });
  const initMarketData = async () => ({ store: { loadAllTickers: async () => [] }, dataProvider, persistence: { close() {} } }) as never;
  const printed: PrintedCliResult["result"][] = [];
  await search("mitsubishi", { initMarketData, printResult: (result) => { printed.push(result); } });
  const rows = printed[0]!.data as Array<{ category: string; symbol: string; exchange: string }>;
  expect(rows.filter((item) => item.category !== "Other Matches").map((item) => `${item.symbol} ${item.category}`))
    .toEqual(["8058:JPX Primary Listing", "MITT Other Listings"]);
});

test("a code of digits is listed with its venue, the form quote takes, and any other symbol as listed", () => {
  // 9 Nov 2026: search listed `9042 … HKEX`, and `quote 9042` asked to choose between JPX and HKEX.
  const line = (label: string, exchange: string) => quotableSearchSymbol({ label, result: { exchange } } as never);
  expect(line("9042", "HKEX")).toBe("9042:HKEX");
  expect(line("7203", "JPX")).toBe("7203:JPX");
  expect(line("SAN", "EPA")).toBe("SAN");
  expect(line("9042", "")).toBe("9042");
});

/**
 * `search ultrapro` on 11 Nov 2026, with the default watchlist saved: MSFT, AAPL and NVDA, which the UltraPro funds
 * hold, were listed under Saved beside TQQQ, though `--json` said `saved: false` and Source read "—".
 */
test("Saved lists only saved rows, each saying so; a saved company a theme's funds hold stays related", async () => {
  const row = (symbol: string, name: string, exchange: string, type: string, extra: Record<string, unknown> = {}) =>
    ({ providerId: "gloomberb-cloud", symbol, name, exchange, type, primaryExchange: exchange, ...extra });
  const held = { searchKeywords: ["ultrapro"] };
  const answer = [
    row("TQQQ", "ProShares UltraPro QQQ", "NASDAQ", "ETF"), row("UPRO", "ProShares UltraPro S&P 500", "ARCA", "ETF"),
    row("MSFT", "Microsoft Corporation", "NASDAQ", "EQUITY", held), row("NVDA", "NVIDIA Corporation", "NASDAQ", "EQUITY", held),
  ];
  const tickers = [
    createTestTicker("TQQQ", "ProShares UltraPro QQQ", { assetCategory: "ETF" }),
    createTestTicker("MSFT", "Microsoft Corporation"),
    createTestTicker("NVDA", "NVIDIA Corporation"),
  ];
  const dataProvider = createTestDataProvider({ search: async () => answer as never });
  const initMarketData = async () => ({ store: { loadAllTickers: async () => tickers }, dataProvider, persistence: { close() {} } }) as never;
  const printed: PrintedCliResult["result"][] = [];
  await search("ultrapro", { initMarketData, printResult: (result) => { printed.push(result); } });
  const rows = printed[0]!.data as Array<{ category: string; symbol: string; saved: boolean; source: string }>;
  expect(rows.map((item) => `${item.symbol}:${item.category}:${item.saved ? item.source : "-"}`)).toEqual([
    "TQQQ:Saved:Saved", "UPRO:Funds & Derivatives:-", "MSFT:Related:Saved", "NVDA:Related:Saved",
  ]);
});

/**
 * `search Hermes` on 13 Nov 2026 listed two Federated Hermes ETFs, PAYX, USB and ABBV as "Related", and the OTC
 * receipt HESAY as the primary listing: the service tags a fund family's funds and holdings with the word, which read
 * it as a sector, so its funds led and Hermès's home line in Paris was no longer the service's first answer.
 */
test("a company's name the service also tags funds with leads with the company's home line, its receipt under Other Listings", async () => {
  const row = (symbol: string, name: string, exchange: string, type: string, extra: Record<string, unknown> = {}) =>
    ({ providerId: "gloomberb-cloud", symbol, name, exchange, type, primaryExchange: exchange, ...extra });
  const hermes = "Hermès International Société en commandite par actions";
  const tagged = { searchKeywords: ["hermes"] };
  const funds = [
    row("FDV", "Federated Hermes U.S. Strategic Dividend ETF", "ARCA", "ETF", tagged),
    row("MKTN", "Federated Hermes MDT Market Neutral ETF", "ARCA", "ETF", tagged),
  ];
  const answer = [
    row("RMS", hermes, "EPA", "Common Stock", { homeListing: true, popularity: 21282 }),
    row("HESAY", "Hermes International SCA Unsponsored ADR", "OTC", "American Depositary Receipt", { popularity: 20326 }),
    row("7856", "Hermes Testing Solutions Inc.", "TWSE", "Common Stock"),
    row("HMI", hermes, "XETRA", "Common Stock"), row("RMS", hermes, "VIE", "Common Stock"),
    row("HERMES80", "Hermès International SCA Depositary Receipt", "SET", "Depositary Receipt"),
    row("HRMS", "Hermès International SCA", "NEO", "Depositary Receipt"),
    ...funds,
    row("PAYX", "Paychex, Inc.", "NASDAQ", "EQUITY", tagged), row("USB", "U.S. Bancorp", "NYSE", "EQUITY", tagged),
  ];
  const dataProvider = createTestDataProvider({ search: async (query: string) => (/ETF$/.test(query) ? funds : answer) as never });
  const initMarketData = async () => ({ store: { loadAllTickers: async () => [] }, dataProvider, persistence: { close() {} } }) as never;
  for (const query of ["Hermes", "Hermès"]) {
    const printed: PrintedCliResult["result"][] = [];
    await search(query, { initMarketData, printResult: (result) => { printed.push(result); } });
    const rows = printed[0]!.data as Array<{ category: string; symbol: string; exchange: string }>;
    const listed = rows.map((item) => `${item.symbol}:${item.exchange} ${item.category}`);
    expect(listed[0]).toBe("RMS:EPA Primary Listing");
    expect(listed).toContain("HESAY:OTC Other Listings");
    expect(listed.indexOf("HMI:XETRA Other Listings")).toBeGreaterThan(0);
    // The fund family's funds and their holdings follow the company's lines.
    const firstOther = rows.findIndex((item) => item.category !== "Primary Listing" && item.category !== "Other Listings");
    expect(rows.slice(0, firstOther).every((item) => item.category === "Primary Listing" || item.category === "Other Listings")).toBe(true);
    expect(rows.slice(firstOther).map((item) => item.category)).not.toContain("Primary Listing");
  }
});
