import { expect, test } from "bun:test";
import type { InstrumentSearchResult } from "../types/instrument";
import type { Quote } from "../types/financials";
import { ProviderBusyError } from "../sources/provider-errors";
import { findListingOfCompanyName, serviceMarkedOtherListing } from "./company-name-listing";
import { buildTickerSearchCandidates } from "./search";
import { search } from "../cli/commands/search";
import { createTestDataProvider } from "../test-support/data-provider";
import type { PrintedCliResult } from "../test-support/cli-context";

const listing = (symbol: string, name: string, exchange: string, type = "Common Stock"): InstrumentSearchResult =>
  ({ providerId: "test", symbol, name, exchange, type, currency: "USD" });

/** A row as Gloom Cloud answers it: symbol | name | exchange | type, then `home` for its home line and the name it marks it with. */
const row = (line: string): InstrumentSearchResult => {
  const [symbol, name, exchange, type, home, alias] = line.split(" | ");
  return {
    providerId: "gloomberb-cloud", symbol: symbol!, name: name!, exchange: exchange!, type: type!,
    ...home === "home" ? { homeListing: true } : {}, ...alias ? { searchAliases: [alias] } : {},
  };
};

/** The service's answers by query, whatever its case; search asks for the name and for it without its legal form. */
const answering = (answers: Record<string, string[]>) => ({
  search: async (query: string) => (answers[query.toUpperCase()] ?? []).map(row),
});

// Trimmed from the service's answers on 2026-10-24.
const EUROPE: Record<string, string[]> = {
  "SIEMENS AG": [
    "SIE | Siemens Aktiengesellschaft | XETRA | EQUITY | home | SIEMENS AG",
    "SIEGY | Siemens Aktiengesellschaft | PNK | EQUITY",
    "SIEME | SIEMENS AG | BUD | Common Stock",
    "SMNS | Siemens AG American Depositary Receipt | TSX | Depositary Receipt",
  ],
  SIEMENS: [
    "SIE | Siemens Aktiengesellschaft | XETRA | Common Stock | home | SIEMENS",
    "SIEMENS | Siemens Ltd. | NSE | Common Stock | home",
    "ENR | Siemens Energy AG | XETRA | Common Stock | home",
    "4SIE | SIEMENS | BIT | Common Stock",
  ],
  "VOLVO AB": [
    "VOLV.B | Volvo AB | SFB | Common Stock | home",
    "VLVLY | Volvo AB Unsponsored ADR | OTC | American Depositary Receipt",
    "VOLV.A | Volvo AB | SFB | Common Stock",
    "VOLVF | Volvo AB (B) | OTC | Common Stock",
    "VOLV | Volvo AB (B) | WSE | Common Stock",
  ],
  VOLVO: ["VOLCAR.B | Volvo Car AB | SFB | Common Stock", "VOLV.B | Volvo AB | SFB | Common Stock | home"],
  "SAP SE": [
    "SAP | SAP SE | XETRA | Common Stock | home | SAP SE",
    "SAP | SAP SE ADR | NYSE | American Depositary Receipt",
    "SAPGF | SAP SE | OTC | Common Stock",
  ],
  SAP: [
    "SAP | SAP SE | XETRA | Common Stock | home | SAP",
    "SAP | SAP SE ADR | NYSE | American Depositary Receipt",
    "SAP | Saputo Inc. | TSX | Common Stock | home",
  ],
};

test("a European company typed with its legal form is its primary listing, as the command bar lists it first, not a line abroad or a receipt", async () => {
  const service = answering(EUROPE);
  // Before, 4SIE in Milan (no quote), VOLV in Warsaw and SAP's NYSE receipt: names with no more words than typed, a shorter symbol, a US line.
  for (const [typed, symbol, exchange] of [["SIEMENS AG", "SIE", "XETRA"], ["VOLVO AB", "VOLV.B", "SFB"], ["SAP SE", "SAP", "XETRA"]] as const) {
    expect(await findListingOfCompanyName(service, typed), typed).toMatchObject({ symbol, exchange });
    const [lead] = buildTickerSearchCandidates({ query: typed, tickers: new Map(), providerResults: EUROPE[typed]!.map(row) });
    expect({ symbol: lead?.symbol, exchange: lead?.result?.exchange }, `command bar ${typed}`).toEqual({ symbol, exchange });
  }
  // A company listed by receipts alone is its receipt, and a US company its US line, marked or not.
  const pdd = [
    "PDDC | PDD Holdings Inc. - CEDEAR | BYMA | Depositary Receipt",
    "PDD | PDD Holdings Inc. ADR | NASDAQ | American Depositary Receipt | home | PDD Holdings",
    "9PDA | PDD Holdings Inc. American Depositary Receipt | FWB2 | American Depositary Receipt",
  ];
  const apple = ["APC | Apple Inc. | XETRA | Common Stock", "AAPL | Apple Inc. | NASDAQ | Common Stock | home | Apple", "AAPL | Apple Inc. | BMV | Common Stock"];
  const unmarked = (rows: string[]) => rows.map((line) => line.split(" | ").slice(0, 4).join(" | "));
  for (const rows of [(lines: string[]) => lines, unmarked]) {
    expect(await findListingOfCompanyName(answering({ "PDD HOLDINGS": rows(pdd) }), "PDD Holdings")).toMatchObject({ symbol: "PDD", exchange: "NASDAQ" });
    expect(await findListingOfCompanyName(answering({ APPLE: rows(apple) }), "Apple", { oneWord: true })).toMatchObject({ symbol: "AAPL", exchange: "NASDAQ" });
  }
});

test("a company's name opens the listing search calls its primary, not a one-off line abroad whose short name matched", async () => {
  // `search lufthansa` against the service, 2026-10-29: no home line marked, Budapest's LUFTHANSA has no search score.
  const scored = (line: string, popularity?: number) => ({ ...row(line), ...popularity ? { popularity } : {} });
  const answer = [
    scored("DLAKY | Lufthansa Sponsored ADR | OTC | American Depositary Receipt", 20071),
    scored("LUFTH | LUFTHANSA | BUD | Common Stock"),
    scored("LHAB | Lufthansa AG Sponsored ADR | FWB2 | American Depositary Receipt"),
    scored("LHA | Deutsche Lufthansa AG | XETRA | Common Stock", 20989),
    scored("LHA | Deutsche Lufthansa AG | FWB2 | Common Stock", 20037),
    scored("DLAKF | Deutsche Lufthansa AG | OTC | Common Stock", 20006),
    scored("4LHA | DEUTSCHE LUFTHANSA | BIT | Common Stock"),
  ];
  const service = { search: async () => answer };
  const initMarketData = async () => ({
    store: { loadAllTickers: async () => [] }, dataProvider: createTestDataProvider({ search: service.search }), persistence: { close() {} },
  }) as never;
  const printed: PrintedCliResult["result"][] = [];
  await search("lufthansa", { initMarketData, printResult: (result) => { printed.push(result); } });
  const primary = (printed[0]!.data as Array<{ category: string; symbol: string; exchange: string }>)
    .find((item) => item.category === "Primary Listing");
  expect(primary).toMatchObject({ symbol: "LHA", exchange: "XETRA" });
  for (const [typed, options] of [["lufthansa", { oneWord: true }], ["Lufthansa", {}], ["Deutsche Lufthansa", {}]] as const) {
    expect(await findListingOfCompanyName(service, typed, options), typed).toMatchObject({ symbol: "LHA", exchange: "XETRA" });
  }
  // The command bar lists it first too, so Enter on the name opens it.
  const [lead] = buildTickerSearchCandidates({ query: "lufthansa", tickers: new Map(), providerResults: answer });
  expect({ symbol: lead?.symbol, exchange: lead?.result?.exchange }).toEqual({ symbol: "LHA", exchange: "XETRA" });
  // A line the service marks with the name keeps the lead over a line searched more: the mark is the company.
  const marked = [scored("SIEME | SIEMENS AG | BUD | Common Stock | - | SIEMENS AG"), scored("SIE | SIEMENS AG | WSE | Common Stock", 30000)];
  expect(await findListingOfCompanyName({ search: async () => marked }, "SIEMENS AG")).toMatchObject({ symbol: "SIEME", exchange: "BUD" });
});

test("with quoted, a listing with no quote gives way to the next of its company's lines that has one, never to another company's home line", async () => {
  const quoting = (answers: Record<string, string[]>, priced: string[], busy = false) => ({
    ...answering(answers),
    getQuote: async (symbol: string, exchange?: string): Promise<Quote> => {
      if (busy) throw new ProviderBusyError("busy");
      if (!priced.includes(`${symbol}:${exchange}`)) throw new Error(`Not a ticker: ${symbol}.`);
      return { symbol, price: 10, currency: "EUR", change: 0, changePercent: 0, lastUpdated: 1 };
    },
  });
  // An older service marks no home line: Warsaw's VOLV, the shorter symbol, goes first, and its venue no longer prices it.
  const volvo = { "VOLVO AB": ["VOLV | Volvo AB (B) | WSE | Common Stock", "VOLV.B | Volvo AB | SFB | Common Stock"] };
  expect(await findListingOfCompanyName(quoting(volvo, ["VOLV.B:SFB"]), "VOLVO AB", { quoted: true })).toMatchObject({ symbol: "VOLV.B", exchange: "SFB" });
  expect(await findListingOfCompanyName(quoting(volvo, ["VOLV.B:SFB"]), "VOLVO AB")).toMatchObject({ symbol: "VOLV", exchange: "WSE" });
  // None priced, or a source too busy to say: the first stands.
  expect(await findListingOfCompanyName(quoting(volvo, []), "VOLVO AB", { quoted: true })).toMatchObject({ symbol: "VOLV" });
  expect(await findListingOfCompanyName(quoting(volvo, ["VOLV.B:SFB"], true), "VOLVO AB", { quoted: true })).toMatchObject({ symbol: "VOLV" });
  // Siemens Ltd. in India is another company, though its name has the same words: its home line, and its line named alike.
  const siemens = { "SIEMENS AG": [EUROPE["SIEMENS AG"]![0]!], SIEMENS: [EUROPE.SIEMENS![1]!, "SIEMENS | Siemens Ltd. | BSE | Common Stock"] };
  expect(await findListingOfCompanyName(quoting(siemens, ["SIEMENS:NSE", "SIEMENS:BSE"]), "SIEMENS AG", { quoted: true }))
    .toMatchObject({ symbol: "SIE", exchange: "XETRA" });
});

// "Zions Bancorporation" was stored as ZION:IEX, a line search lists first and no source prices.
test("with quoted, a US line with no quote is the listing its symbol's own quote prices, as `quote ZION` reads it", async () => {
  const zions = { "ZIONS BANCORPORATION": ["ZION | Zions Bancorporation N.A. | IEX | Common Stock", "ZB1 | ZIONS BANCORPORATION | XSTU | Common Stock"] };
  const asked: string[] = [];
  const source = {
    ...answering(zions),
    getQuote: async (symbol: string, exchange = ""): Promise<Quote> => {
      asked.push(`${symbol}:${exchange}`);
      if (symbol !== "ZION" || exchange) throw new Error(`No quote provider available for ${symbol}`);
      return { symbol, price: 67.71, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1, listingExchangeName: "NASDAQ" };
    },
  };
  expect(await findListingOfCompanyName(source, "Zions Bancorporation", { quoted: true })).toMatchObject({ symbol: "ZION", exchange: "NASDAQ" });
  expect(asked).toEqual(["ZION:IEX", "ZION:"]);
});

test("with quoted, a company that moved off its US line is followed to the symbol it took before any line abroad, and says so", async () => {
  // Trimmed from the service's answers on 2026-10-28, after Getty Images' NYSE line became GETYQ.
  const getty = { "GETTY IMAGES": [
    "GETY | Getty Images Holdings, Inc. | NYSE | Common Stock | home",
    "GETY | Getty Images Holdings Inc | PNK | EQUITY",
    "GETYQ | Getty Images Holdings, Inc. | OTC | Common Stock",
    "L2S | Getty Images Holdings, Inc. | MUNICH | Common Stock",
  ] };
  const asked: string[] = [];
  const service = {
    ...answering(getty),
    // Munich still quotes the old shares; the NYSE line has none.
    getQuote: async (symbol: string, exchange?: string): Promise<Quote> => {
      if (`${symbol}:${exchange}` !== "L2S:MUNICH") throw new Error(`No quote provider available for ${symbol}`);
      return { symbol, price: 0.019, currency: "EUR", change: 0, changePercent: 0, lastUpdated: 1 };
    },
  };
  const movedLine = async ({ symbol, exchange, quote, name }: { symbol: string; exchange: string; quote: Quote | null; name: string | null }) => {
    asked.push(`${symbol}:${exchange}:${quote ? "quoted" : "none"}:${name}`);
    return symbol === "GETY" ? { symbol: "GETYQ", note: "GETY became GETYQ on 2026-10-22" } : null;
  };
  expect(await findListingOfCompanyName(service, "getty images", { quoted: true, movedLine })).toEqual({
    symbol: "GETYQ", exchange: "", name: "Getty Images Holdings, Inc.", moved: "GETY became GETYQ on 2026-10-22",
  });
  expect(asked).toEqual(["GETY:NYSE:none:Getty Images Holdings, Inc."]);
  // With no change to follow, the next line with a quote, as before.
  expect(await findListingOfCompanyName(service, "getty images", { quoted: true, movedLine: async () => null })).toMatchObject({ symbol: "L2S", exchange: "MUNICH" });
  // A first line abroad is not a US line a company leaves for another symbol: no lookup.
  asked.length = 0;
  const volvo = { "VOLVO AB": ["VOLV | Volvo AB (B) | WSE | Common Stock", "VOLV.B | Volvo AB | SFB | Common Stock"] };
  await findListingOfCompanyName({ ...answering(volvo), getQuote: service.getQuote }, "VOLVO AB", { quoted: true, movedLine });
  expect(asked).toEqual([]);
});

test("a company's name is its own common stock on its US line, never a subsidiary sharing the word, a line abroad, or a preferred or note", async () => {
  // Search order puts the subsidiary and the line abroad first.
  const whirlpool = [
    listing("WHIRLPOOL", "Whirlpool of India Limited", "NSE"),
    listing("WHR", "Whirlpool Corp", "XETRA"),
    listing("WHR", "Whirlpool Corp", "NYSE"),
  ];
  expect(await findListingOfCompanyName({ search: async () => whirlpool }, "Whirlpool Corporation"))
    .toEqual({ symbol: "WHR", exchange: "NYSE", name: "Whirlpool Corp" });
  // The preferred and the note have the shorter symbols, which would otherwise go first.
  const acme = [
    listing("AC", "Acme Corp", "NYSE", "Preferred Stock"),
    listing("AN", "Acme Corp", "NYSE", "Notes"),
    listing("ACME", "Acme Corp", "NYSE"),
  ];
  expect(await findListingOfCompanyName({ search: async () => acme }, "Acme Corporation"))
    .toEqual({ symbol: "ACME", exchange: "NYSE", name: "Acme Corp" });
});

test("a word of the name may be its short form, and the listing whose name says no more than the one typed still wins", async () => {
  // "philip morris intl" is Philip Morris International, never INTL or a longer name.
  const philip = [
    listing("INTL", "Main International ETF", "BATS", "ETF"),
    listing("PMI", "Philip Morris International Holdings Ltd", "LSE"),
    listing("PM", "Philip Morris International Inc.", "NYSE"),
  ];
  expect(await findListingOfCompanyName({ search: async () => philip }, "philip morris intl"))
    .toEqual({ symbol: "PM", exchange: "NYSE", name: "Philip Morris International Inc." });
  expect(await findListingOfCompanyName({ search: async () => philip }, "phillip morris intl")).toBeNull();
});

test("a bare symbol read on a minor listing abroad finds the listing the service marks with the word on another venue", async () => {
  // 6 Nov 2026: `quote NTT` gave NTT System (Warsaw) with no note, though search names 9432 on JPX as NTT, Inc.
  const ntt = answering({ NTT: ["NTT | NTT System S.A. | WSE | Common Stock", "9432 | NTT, Inc. | JPX | Common Stock | home | NTT"] });
  expect(await serviceMarkedOtherListing(ntt, "NTT", "WSE")).toEqual({ symbol: "9432", exchange: "JPX", name: "NTT, Inc." });
  // Read there already, or marked nowhere, there is nothing to add.
  expect(await serviceMarkedOtherListing(ntt, "NTT", "JPX")).toBeNull();
  expect(await serviceMarkedOtherListing(answering({ NTT: ["NTT | NTT System S.A. | WSE | Common Stock"] }), "NTT", "WSE")).toBeNull();
});

test("a name the service answers first with a line it marks as its company's home is that line, though another line is named nearer", async () => {
  // `search Panasonic` and `search "Nippon Yusen"` against the service, 2026-11-06, trimmed. Before: 3719 on BURSAMY, a
  // Malaysian subsidiary reached through a Frankfurt line under Panasonic's old name, and an ISIN-coded Stuttgart line
  // named "Nippon Yusen K.K.", the same legal form spelled short.
  const answers: Record<string, string[]> = {
    PANASONIC: [
      "6752 | Panasonic Holdings Corporation | JPX | Common Stock | home",
      "PCRHY | Panasonic Holdings Corp | OTC | American Depositary Receipt",
      "PCRFF | Panasonic Holdings Corporation | OTC | Common Stock",
      "3719 | Panasonic Manufacturing Malaysia Berhad | BURSAMY | Common Stock",
      "MAT1 | Panasonic Holdings Corporation | FWB2 | Common Stock",
      "MATA | Panasonic Corporation | FWB2 | Common Stock",
    ],
    "NIPPON YUSEN": [
      "9101 | Nippon Yusen Kabushiki Kaisha | JPX | Common Stock | home",
      "NYKA | Nippon Yusen Kabushiki Kaisha | FWB2 | Common Stock",
      "JP3753000003 | Nippon Yusen K.K. | XSTU | Common Stock",
    ],
  };
  for (const [typed, key, options] of [["Panasonic", "6752:JPX", { oneWord: true }], ["Nippon Yusen", "9101:JPX", {}]] as const) {
    const found = await findListingOfCompanyName(answering(answers), typed, options);
    expect(`${found?.symbol}:${found?.exchange}`, typed).toBe(key);
    const [lead] = buildTickerSearchCandidates({ query: typed, tickers: new Map(), providerResults: answers[typed.toUpperCase()]!.map(row) });
    expect(`${lead?.symbol}:${lead?.result?.exchange}`, `command bar ${typed}`).toBe(key);
  }
});

// Trimmed from the service's answers on 2026-11-06: it spells Turkish names with and without their letters, lists
// Istanbul home lines under part of the name only, and types an issuer's bonds as common stock.
const ISTANBUL: Record<string, string[]> = {
  "SABANCI HOLDING": ["SAHOL.IS | Haci Ömer Sabanci Holding A.S. | BIST | EQUITY"],
  "TURK HAVA YOLLARI": [
    "TKHVY | Türk Hava Yollari Anonim Ortakligi | PNK | Depositary Receipt",
    "TU5A | Turk Hava Yollari A.O. Unsponsored ADR | XDUS | American Depositary Receipt",
    "TU5A | Türk Hava Yollari Anonim Ortakligi | FWB2 | EQUITY",
  ],
  "HAVA YOLLARI": ["THYAO.IS | Türk Hava Yollari Anonim Ortakligi | BIST | EQUITY", "TU5A | Türk Hava Yollari Anonim Ortakligi | FWB2 | EQUITY"],
  "TURKIYE IS BANKASI": [
    "XS297014501 | Turkiye Is Bankasi A.S. 9.125% Perpetual Junior Subordinated Notes | MUNICH | Common Stock",
    "XS317436815 | Turkiye Is Bankasi A.S. 7.375% Notes due 2 April 2036 | MUNICH | Common Stock",
  ],
  GARANTI: [
    "GARFA | Garanti Faktoring A.S. | BIST | Common Stock",
    "GRNYO | Garanti Yatirim Ortakligi A.S. | BIST | Common Stock",
    "GARAN | Türkiye Garanti Bankası A.Ş. | BIST | Common Stock",
    "TKGBY | Turkiye Garanti Bankasi A.S. | OTC | American Depositary Receipt",
    "GBKB | Turkiye Garanti Bankasi A.S. ADR | FWB2 | American Depositary Receipt",
    "XS320571561 | Türkiye Garanti Bankası Anonim Şirketi 7.625% Subordinated Notes due 2036 | MUNICH | Common Stock",
    "TKGBF | Türkiye Garanti Bankasi A.Ş. | OTC | Common Stock",
  ],
};

test("a Turkish name, with its letters or without, is its company's Istanbul line, never a line abroad, a receipt or a bond", async () => {
  const istanbul = answering(ISTANBUL);
  const read = async (typed: string, options = {}) => (await findListingOfCompanyName(istanbul, typed, options))?.symbol ?? null;
  // ı does not decompose: "Sabancı" is searched as Sabanci, and GARAN.IS on BIST is GARAN there.
  expect(await findListingOfCompanyName(istanbul, "Sabancı Holding")).toMatchObject({ symbol: "SAHOL", exchange: "BIST" });
  // The whole name lists the airline only in Frankfurt, over the counter and by receipt; its later words list THYAO.
  expect(await read("Turk Hava Yollari")).toBe("THYAO");
  expect(await read("Türk Hava Yolları")).toBe("THYAO");
  // Bonds named for their issuer and typed as common stock are no answer to its name.
  expect(await read("Turkiye Is Bankasi")).toBeNull();
  // One word that names a factoring company first is the bank listed broadly on the same market.
  expect(await findListingOfCompanyName(istanbul, "Garanti", { oneWord: true })).toMatchObject({ symbol: "GARAN", exchange: "BIST" });
});
