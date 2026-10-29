import { expect, test } from "bun:test";
import { searchCandidatesForCli } from "../../cli/commands/search";
import type { Quote } from "../../types/financials";
import type { DataProvider } from "../../types/data-provider";
import type { InstrumentSearchResult } from "../../types/instrument";
import { findListingOfCompanyName } from "../company-name-listing";
import fixture from "./fixtures/company-name-answers-2026-10-23.json";
import { LISTING_SEARCH_LIMIT, searchTickerCandidates } from ".";

/**
 * A search row as the fixture writes it: symbol | name | exchange | type, then
 * when the service sent them, its search aliases, popularity, currency,
 * primary exchange when another, keywords and a provider other than the cloud.
 */
const row = (line: string): InstrumentSearchResult => {
  const [symbol, name, exchange, type, aliases, popularity, currency, primary, keywords, provider] = line.split(" | ");
  return {
    providerId: provider || "gloomberb-cloud", symbol: symbol!, name: name!, exchange: exchange!, primaryExchange: primary || exchange!,
    type: type!,
    ...currency ? { currency } : {},
    ...aliases ? { searchAliases: aliases.split("; ") } : {},
    ...popularity ? { popularity: Number(popularity) } : {},
    ...keywords ? { searchKeywords: keywords.split("; ") } : {},
  };
};

/** The service as search asks it: its answer for the words, whatever their case and spacing. */
function serviceAnswering(answers: Record<string, string[]>): DataProvider {
  const key = (text: string) => text.trim().replace(/\s+/g, " ").toUpperCase();
  const byQuery = new Map(Object.entries(answers).map(([query, rows]) => [key(query), rows]));
  return {
    id: "gloomberb-cloud",
    search: async (query: string) => (byQuery.get(key(query)) ?? []).map(row),
    getQuote: async () => { throw new Error("no quote"); },
  } as unknown as DataProvider;
}

/**
 * What the CLI's data provider read from the live service on the fixture's
 * date, for every search the CLI ran for these names (each spelling it tries)
 * and every quote it asked for.
 */
function capturedService(): DataProvider {
  const searches: Record<string, number> = fixture.searches;
  const quotes: Record<string, Partial<Quote> | null> = fixture.quotes;
  return {
    id: "gloomberb-cloud",
    search: async (query: string) => {
      const answer = searches[query];
      if (answer == null) throw new Error(`not captured: search "${query}"`);
      return fixture.answers[answer]!.map(row);
    },
    getQuote: async (symbol: string) => {
      if (!(symbol in quotes)) throw new Error(`not captured: quote ${symbol}`);
      const quote = quotes[symbol];
      if (!quote) throw new Error(`no quote for ${symbol}`);
      return quote as Quote;
    },
  } as unknown as DataProvider;
}

const first = async (dataProvider: DataProvider, query: string) => (await searchTickerCandidates({
  query, tickers: new Map(), dataProvider, localLimit: 6, totalLimit: LISTING_SEARCH_LIMIT, searchContext: { limit: LISTING_SEARCH_LIMIT },
}))[0];

// The 100 largest US companies (operating, by market value, 2026-10-22), each by the short names people say.
const LARGEST: Array<[symbols: string[], names: string[]]> = [
  [["NVDA"], ["Nvidia"]], [["AAPL"], ["Apple"]], [["GOOGL", "GOOG"], ["Google", "Alphabet"]], [["MSFT"], ["Microsoft"]],
  [["AMZN"], ["Amazon"]], [["SPCX"], ["SpaceX"]], [["META"], ["Meta", "Facebook"]], [["AVGO"], ["Broadcom"]],
  [["TSLA"], ["Tesla"]], [["BRK.B", "BRK.A"], ["Berkshire", "Berkshire Hathaway"]], [["LLY"], ["Eli Lilly", "Lilly"]],
  [["MU"], ["Micron"]], [["WMT"], ["Walmart"]], [["AMD"], ["AMD", "Advanced Micro Devices"]],
  [["JPM"], ["JPMorgan", "JP Morgan"]], [["V"], ["Visa"]], [["XOM"], ["Exxon", "ExxonMobil"]],
  [["JNJ"], ["Johnson & Johnson"]], [["MA"], ["Mastercard"]], [["ABBV"], ["AbbVie"]], [["INTC"], ["Intel"]],
  [["PLTR"], ["Palantir"]], [["CVX"], ["Chevron"]], [["COST"], ["Costco"]], [["CSCO"], ["Cisco"]],
  [["KO"], ["Coca Cola", "Coca-Cola"]], [["ORCL"], ["Oracle"]], [["UNH"], ["UnitedHealth"]], [["MRK"], ["Merck"]],
  [["PG"], ["Procter & Gamble"]], [["BAC"], ["Bank of America", "BofA"]], [["CAT"], ["Caterpillar"]],
  [["LRCX"], ["Lam Research"]], [["AMAT"], ["Applied Materials"]], [["HD"], ["Home Depot"]], [["DELL"], ["Dell"]],
  [["PM"], ["Philip Morris"]], [["GE"], ["General Electric"]], [["MS"], ["Morgan Stanley"]],
  [["PANW"], ["Palo Alto Networks"]], [["NFLX"], ["Netflix"]], [["GS"], ["Goldman", "Goldman Sachs"]],
  [["TXN"], ["Texas Instruments"]], [["RTX"], ["Raytheon"]], [["TMO"], ["Thermo Fisher"]], [["WFC"], ["Wells Fargo"]],
  [["GEV"], ["GE Vernova"]], [["CRWD"], ["CrowdStrike"]], [["AMGN"], ["Amgen"]], [["IBM"], ["IBM"]],
  [["ANET"], ["Arista"]], [["LIN"], ["Linde"]], [["SHOP"], ["Shopify"]], [["MRVL"], ["Marvell"]],
  [["AXP"], ["American Express"]], [["KLAC"], ["KLA"]], [["C"], ["Citigroup"]], [["SNDK"], ["Sandisk"]],
  [["CRM"], ["Salesforce"]], [["ADI"], ["Analog Devices"]], [["APH"], ["Amphenol"]], [["DIS"], ["Disney"]],
  [["GILD"], ["Gilead"]], [["QCOM"], ["Qualcomm"]], [["BLK"], ["BlackRock"]], [["PEP"], ["Pepsi", "PepsiCo"]],
  [["VZ"], ["Verizon"]], [["ABT"], ["Abbott"]], [["COP"], ["ConocoPhillips"]], [["MCD"], ["McDonald's"]],
  [["DE"], ["Deere", "John Deere"]], [["UNP"], ["Union Pacific"]], [["PFE"], ["Pfizer"]], [["WELL"], ["Welltower"]],
  [["SCCO"], ["Southern Copper"]], [["TMUS"], ["T-Mobile"]], [["DHR"], ["Danaher"]], [["NEE"], ["NextEra"]],
  [["TJX"], ["TJX"]], [["SCHW"], ["Charles Schwab", "Schwab"]], [["STX"], ["Seagate"]], [["NOW"], ["ServiceNow"]],
  [["ETN"], ["Eaton"]], [["BA"], ["Boeing"]], [["ISRG"], ["Intuitive Surgical"]], [["T"], ["AT&T"]],
  [["ACN"], ["Accenture"]], [["IBKR"], ["Interactive Brokers"]], [["WDC"], ["Western Digital"]], [["UBER"], ["Uber"]],
  [["CB"], ["Chubb"]], [["MPC"], ["Marathon Petroleum"]], [["VRTX"], ["Vertex"]], [["BX"], ["Blackstone"]],
  [["SPGI"], ["S&P Global"]], [["PGR"], ["Progressive"]], [["FTNT"], ["Fortinet"]],
  [["LMT"], ["Lockheed Martin", "Lockheed"]], [["COF"], ["Capital One"]], [["VLO"], ["Valero"]],
];

test("the spoken names of the 100 largest US companies list their common stock first, as the service ranks them", async () => {
  expect(LARGEST).toHaveLength(100);
  const service = capturedService();
  const missed: string[] = [];
  for (const [symbols, names] of LARGEST) {
    for (const name of names) {
      // The search pane's order, and the CLI's, which picks a primary listing among the company's lines.
      const leads = [["pane", await first(service, name)], ["cli", (await searchCandidatesForCli({ query: name, tickers: [], dataProvider: service }))[0]]] as const;
      for (const [where, lead] of leads) {
        const exchange = lead?.result?.exchange ?? "";
        if (!lead || !symbols.includes(lead.symbol) || !["NYSE", "NASDAQ"].includes(exchange)) {
          missed.push(`${where} ${name}: ${lead ? `${lead.symbol}:${exchange}` : "nothing"}`);
        }
      }
    }
  }
  // One word that only starts a company's name is no name of it to the service, which reads "Berkshire" as a
  // theme and leads with the funds named after it until it knows Berkshire Hathaway by that word.
  expect(missed).toEqual(["pane Berkshire: OMAH:ARCA", "cli Berkshire: OMAH:ARCA"]);
});

test("the CLI's primary listing of a name is the company the service marks with it, not a namesake searched more", async () => {
  // "coca cola", 2026-10-23: the service marks KO, read by its symbol and so unscored; the bottlers carry
  // a popularity score and every word of "Coca-Cola".
  const answer = [
    "KO | The Coca-Cola Company | NYSE | Common Stock | Coca Cola",
    "CCEP | Coca-Cola Europacific Partners PLC | NASDAQ | EQUITY |  | 20581",
    "COKE | Coca-Cola Consolidated, Inc. | NASDAQ | EQUITY |  | 24452",
  ];
  const primary = async (query: string, rows: string[]) => (await searchCandidatesForCli({
    query, tickers: [], dataProvider: serviceAnswering({ [query]: rows, [query.replace(/\s+/g, "")]: rows }),
  })).find((candidate) => candidate.category === "Primary Listing");
  expect((await primary("coca cola", answer))?.symbol).toBe("KO");
  // A marked receipt still gives way to its company's home line of the same name.
  const toyota = [
    "TM | Toyota Motor Corporation | NYSE | Depositary Receipt | Toyota Motor",
    "7203 | Toyota Motor Corporation | JPX | Common Stock |  | 30000",
  ];
  expect(await primary("Toyota Motor", toyota)).toMatchObject({ symbol: "7203" });
});

test("a ticker's lines named with and without \"The\" are one company's, its listing in the service's order first", async () => {
  // "TJX", 2026-10-23: the service lists NYSE first; Hanover's line, twelfth, spells the name without "The"
  // ("TJX COMPANIES INC.            R"), which made it the closer match for the ticker.
  const tjx = fixture.answers[fixture.searches.TJX]!;
  expect(tjx.findIndex((line) => line.includes(" | HANOVER | "))).toBeGreaterThan(10);
  expect((await first(serviceAnswering({ TJX: tjx }), "TJX"))?.result?.exchange).toBe("NYSE");
});

test("a large company's name that is only a foreign line's ticker leads with the US line the service marks with it", async () => {
  const visa = [
    "V | Visa Inc. Class A | NYSE | Common Stock | Visa",
    "VISA | Visa Inc. Class A | VIE | Common Stock",
    "VISA | Visa Inc. Class A | WSE | Common Stock",
  ];
  expect((await first(serviceAnswering({ Visa: visa }), "Visa"))?.symbol).toBe("V");
  // Unmarked (an older service), the foreign ticker keeps its exact lead.
  expect((await first(serviceAnswering({ Visa: visa.map((line) => line.replace(/ \| Visa$/, "")) }), "Visa"))?.result?.exchange).toBe("VIE");
  // Where a US line is the ticker, every exact ticker keeps its place, marked or not.
  const sap = ["SAP | SAP SE | XETRA | Common Stock", "SAP | SAP SE | NYSE | Depositary Receipt"];
  const lead = async (rows: string[]) => (await first(serviceAnswering({ SAP: rows }), "SAP"))?.result?.exchange;
  expect(await lead([sap[0]!, `${sap[1]} | SAP`])).toBe(await lead(sap));
  // A ticker with its venue is that listing.
  expect((await first(serviceAnswering({ "VISA:VIE": visa, VISA: visa }), "VISA:VIE"))?.result?.exchange).toBe("VIE");
});

test("a company's name typed where a symbol goes is its common stock, before a fund or index carrying it", async () => {
  const jpm = [
    "^JTEK | JP MORGAN ETF TRUS | NIM | INDEX",
    "JPM | JPMorgan Chase & Co. | NYSE | Common Stock | JPMorgan; JPMorgan Chase",
    "XEMD | BondBloxx JP Morgan USD Emerging Markets 1-10 Year Bond ETF | BATS | ETF",
  ];
  // The service marks JPM with the name run together; the index's words match "JP Morgan" only loosely.
  expect(await findListingOfCompanyName(serviceAnswering({ "JP Morgan": jpm }), "JP Morgan", { meant: true }))
    .toEqual({ symbol: "JPM", exchange: "NYSE", name: "JPMorgan Chase & Co.", named: true });
  // A stock that has every word goes before a fund that does.
  const goldman = [
    "GLDM | Goldman Sachs Physical Gold ETF | ARCA | ETF",
    "GS | The Goldman Sachs Group, Inc. | NYSE | Common Stock",
  ];
  expect(await findListingOfCompanyName(serviceAnswering({ "Goldman Sachs": goldman }), "Goldman Sachs"))
    .toEqual({ symbol: "GS", exchange: "NYSE", name: "The Goldman Sachs Group, Inc." });
});

test("a name read as a fund or an index names the company's stock it says run together, searched under that name", async () => {
  // An older service answers "JP Morgan" with the index and funds only, and "JPMorgan" with the company.
  const service = serviceAnswering({
    "JP Morgan": ["^JTEK | JP MORGAN ETF TRUS | NIM | INDEX", "XEMD | BondBloxx JP Morgan USD Emerging Markets 1-10 Year Bond ETF | BATS | ETF"],
    JPMorgan: ["JPM | JPMorgan Chase & Co. | NYSE | EQUITY", "JEPI | JPMorgan Equity Premium Income ETF | ARCA | ETF"],
  });
  expect(await findListingOfCompanyName(service, "JP Morgan", { meant: true })).toEqual({
    symbol: "^JTEK", exchange: "NIM", name: "JP MORGAN ETF TRUS",
    meant: { symbol: "JPM", exchange: "NYSE", name: "JPMorgan Chase & Co." },
  });
  // Only the listing resolver asks; a name read as a fund that no stock's name runs on from asks nothing.
  expect(await findListingOfCompanyName(service, "JP Morgan")).toEqual({ symbol: "^JTEK", exchange: "NIM", name: "JP MORGAN ETF TRUS" });
  const vanguard = serviceAnswering({ "Vanguard Total": ["VTI | Vanguard Total Stock Market ETF | ARCA | ETF"] });
  expect(await findListingOfCompanyName(vanguard, "Vanguard Total", { meant: true }))
    .toEqual({ symbol: "VTI", exchange: "ARCA", name: "Vanguard Total Stock Market ETF" });
});
