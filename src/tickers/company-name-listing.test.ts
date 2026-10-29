import { expect, test } from "bun:test";
import type { InstrumentSearchResult } from "../types/instrument";
import type { Quote } from "../types/financials";
import { ProviderBusyError } from "../sources/provider-errors";
import { findListingOfCompanyName } from "./company-name-listing";
import { buildTickerSearchCandidates } from "./search";

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
