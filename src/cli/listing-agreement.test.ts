import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestCliContext } from "../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import { marketDataCliCommands } from "./commands/market";
import { quotedListingChoiceNotes } from "./listing-arg";
import { applyListingArgument } from "./pane-functions/resolver";
import { createPaneCatalog } from "./pane-functions/discovery";
import { parsePaneFunctionArgs } from "./pane-functions/options";
import type { PaneFunctionCatalog } from "./pane-functions/catalog";
import type { MarketContext } from "./types";
import { getLoadablePlugins } from "../plugins/catalog";
import { createDefaultConfig } from "../types/config";
import { resolveTickerSearch } from "../tickers/search";
import { canonicalExchange, canonicalTickerKey, parsePublicTickerKey, typedExchangeCode } from "../utils/exchanges";
import { JsonTickerRepository } from "../data/json-ticker-repository";
import { resolveDesktopDeepLinkAction } from "../app/runtime/desktop-deeplink";
import { researchEntryFromSearch } from "../renderers/browser/research-entry";
import { resolveTickerOpenTarget } from "../tickers/open-target";
import { settleTypedListingKey } from "../tickers/listing-venues";
import { tokenizeInlineContent } from "../utils/inline-content-tokenizer";
import { createTestTicker } from "../test-support/ticker";

// Where each symbol trades, as search lists it. 7203 also trades in Riyadh as another company.
const LISTED: Record<string, Array<[exchange: string, name: string]>> = {
  "7203": [["JPX", "Toyota Motor Corporation"], ["TADAWUL", "Saudi Industrial Investment"]],
  RY: [["TSX", "Royal Bank of Canada"], ["NYSE", "Royal Bank of Canada"]],
  SAN: [["NYSE", "Banco Santander, S.A."], ["EPA", "Sanofi"]],
  "600519": [["SSE", "Kweichow Moutai Co., Ltd."]],
  SAP: [["XETRA", "SAP SE"], ["FWB2", "SAP SE"]],
  "247540": [["KOSDAQ", "EcoPro BM Co., Ltd."]],
  VOD: [["LSE", "Vodafone Group Plc"]],
  "0700": [["HKEX", "Tencent Holdings Limited"]],
  AAPL: [["NASDAQ", "Apple Inc."]],
};

/** Each listing as typed, the listing every command must read it as, and whether it says what it read. */
const LISTINGS: Array<[typed: string, key: string, readAs: boolean]> = [
  ["7203:TSE", "7203:JPX", true],
  ["7203:TYO", "7203:JPX", false],
  ["7203:XTKS", "7203:JPX", false],
  ["RY:TSE", "RY:TSX", false],
  ["SAN:EPA", "SAN:EPA", false],
  ["SAN:PAR", "SAN:EPA", false],
  ["SAN:EURONEXT", "SAN:EPA", true],
  ["600519:SHA", "600519:SSE", false],
  ["SAP:FRA", "SAP:FWB2", false],
  ["247540:KRX", "247540:KOSDAQ", true],
  ["VOD:LON", "VOD:LSE", false],
  ["0700:HKG", "0700:HKEX", false],
  ["AAPL", "AAPL", false],
];

let requested: string[] = [];
/** Symbols search leaves out, so a shared code is read from the listing's own quotes. */
const UNSEARCHED = new Set<string>();

function listingQuote(symbol: string, exchange: string) {
  const [bare, venue = exchange] = symbol.split(":");
  const asked = canonicalExchange(venue || LISTED[bare!]?.[0]?.[0]);
  const listing = LISTED[bare!]?.find(([listed]) => listed === asked);
  // Gloom Cloud quotes a KOSDAQ code asked for on KRX from KOSDAQ, answered as KRX with the board it read.
  const board = !listing && asked === "KRX" ? LISTED[bare!]?.find(([listed]) => listed === "KOSDAQ") : undefined;
  if (board) return createTestQuote({ symbol: bare!, name: board[1], currency: "KRW", listingExchangeName: "KRX", tradingExchangeName: "KOSDAQ" });
  if (!listing) throw new Error(`No quote for ${symbol}`);
  return createTestQuote({ symbol: bare!, name: listing[1], currency: "USD", listingExchangeName: listing[0] });
}

const dataProvider = createTestDataProvider({
  search: async (query) => query === "Sanofi"
    ? [{ providerId: "test", symbol: "SNY", name: "Sanofi ADR", exchange: "NASDAQ", type: "ADR", currency: "USD" }]
    : UNSEARCHED.has(query.toUpperCase()) ? []
    : (LISTED[query.toUpperCase()] ?? []).map(([exchange, name]) => ({
      providerId: "test", symbol: query.toUpperCase(), name, exchange, type: "Common Stock", currency: "USD",
    })),
  getQuote: async (symbol, exchange) => listingQuote(symbol, exchange),
  getQuotesBatch: async (targets) => targets.map((target) => {
    requested.push(target.symbol);
    return { target, quote: listingQuote(target.symbol, target.exchange) };
  }),
  getCorporateActions: async (symbol) => {
    requested.push(symbol);
    return { symbol, dividends: [], splits: [], earnings: [] };
  },
  getEarningsCalendar: async (symbols) => symbols.map((symbol) => {
    requested.push(symbol);
    return {
      symbol, name: "", earningsDate: new Date("2026-11-05"), epsEstimate: null, epsActual: null,
      revenueEstimate: null, revenueActual: null, surprise: null, timing: "" as const,
    };
  }),
});

const market = {
  config: createDefaultConfig("/tmp/listing-agreement-test"),
  store: { loadTicker: async () => null, loadAllTickers: async () => [] },
  dataProvider,
} as unknown as MarketContext;

let registry: PaneFunctionCatalog;
beforeAll(async () => { registry = await createPaneCatalog(market, getLoadablePlugins()); });
afterAll(() => registry.destroy());

interface Reading {
  /** The listing the command asked its data for. */
  listing: string;
  /** What it said beside the answer. */
  warnings: string[];
}

async function runCommand(name: string, typed: string): Promise<Reading> {
  requested = [];
  const run = createTestCliContext({ dataProvider });
  await marketDataCliCommands.find((command) => command.name === name)!.execute([typed], run.context);
  return { listing: requested[0]!, warnings: run.printed[0]?.result.warnings ?? [] };
}

async function runFunction(token: string, typed: string, ...options: string[]): Promise<Reading> {
  const parsed = await applyListingArgument(registry, market, parsePaneFunctionArgs([token, typed, ...options], {}));
  const choice = parsed.listing ? await quotedListingChoiceNotes(parsed.listing, market) : [];
  return { listing: parsed.arg, warnings: [...parsed.listingNotes ?? [], ...choice] };
}

/** The command bar opens what search settles on, by its venue. */
async function openInCommandBar(typed: string): Promise<Reading> {
  const resolved = await resolveTickerSearch({ query: typed, activeTicker: null, tickers: new Map(), dataProvider });
  const result = resolved?.kind === "provider" ? resolved.result : null;
  return { listing: result && typed.includes(":") ? `${result.symbol}:${canonicalExchange(result.exchange)}` : typed, warnings: [] };
}

const READERS: Record<string, (typed: string) => Promise<Reading>> = {
  quote: (typed) => runCommand("quote", typed),
  events: (typed) => runCommand("events", typed),
  earnings: (typed) => runCommand("earnings", typed),
  "fn ANR": (typed) => runFunction("ANR", typed),
  "fn ERN": (typed) => runFunction("ERN", typed),
};

/** What a ticker resolves a listing to when it is opened: the ticker's key, by its canonical venue (SAN:PAR is SAN:EPA). */
async function openTicker(query: string): Promise<string> {
  const target = await resolveTickerOpenTarget({ query, tickers: new Map(), dataProvider, tickerRepository: new JsonTickerRepository() });
  return target ? canonicalTickerKey(target.symbol) : "nothing";
}

/**
 * Links and chat never pass through search or a command: a ticker link
 * (gloomberb://ticker/7203:TSE), the web terminal's ?ticker=7203&exchange=TSE,
 * a news link, and a $7203:TSE cashtag in a chat message.
 */
const LINK_READERS: Record<string, (typed: string) => Promise<string>> = {
  "ticker link": async (typed) => {
    const action = resolveDesktopDeepLinkAction(`gloomberb://ticker/${encodeURIComponent(typed)}?tab=overview`);
    return action.type === "open-ticker" ? openTicker(action.symbol) : action.type;
  },
  "web link": async (typed) => {
    const { symbol, exchange } = parsePublicTickerKey(typed);
    const code = typedExchangeCode(typed);
    const entry = researchEntryFromSearch(`?ticker=${symbol}${exchange ? `&exchange=${code}` : ""}`);
    return entry ? openTicker(entry.symbol) : "nothing";
  },
  "news link": async (typed) => {
    const action = resolveDesktopDeepLinkAction(`gloomberb://news/ticker/${encodeURIComponent(typed)}`);
    if (action.type !== "open-news" || !action.symbol) return action.type;
    return canonicalTickerKey(await settleTypedListingKey(action.symbol, market));
  },
  chat: async (typed) => {
    const tags = tokenizeInlineContent(`watching $${typed} into the close`).filter((token) => token.kind === "ticker");
    return tags.length === 1 ? openTicker(tags[0]!.symbol) : `${tags.length} cashtags`;
  },
};

test("every command, fn function, the command bar, links and chat read a listing as quote does, and say what a shared code was read as", async () => {
  for (const [typed, key, readAs] of LISTINGS) {
    for (const [reader, read] of Object.entries(READERS)) {
      const reading = await read(typed);
      expect(reading.listing, `${reader} ${typed}`).toBe(key);
      const said = reading.warnings.filter((warning) => warning.startsWith("Read "));
      expect(said, `${reader} ${typed}`).toEqual(readAs ? [expect.stringMatching(new RegExp(`^Read ${typed} as ${key}: `))] : []);
    }
    expect((await openInCommandBar(typed)).listing, `command bar ${typed}`).toBe(key);
    for (const [reader, read] of Object.entries(LINK_READERS)) {
      expect(await read(typed), `${reader} ${typed}`).toBe(key);
    }
  }
});

test("a code search leaves out is read from the listing's own quotes, not from a board Gloom Cloud answered for it", async () => {
  // Gloom Cloud answers 247540:KRX from KOSDAQ under the KRX name: that is no KRX line.
  UNSEARCHED.add("247540");
  try {
    for (const [reader, read] of Object.entries(READERS)) {
      const reading = await read("247540:KRX");
      expect(reading.listing, reader).toBe("247540:KOSDAQ");
      expect(reading.warnings.filter((warning) => warning.startsWith("Read ")), reader)
        .toEqual([expect.stringMatching(/^Read 247540:KRX as 247540:KOSDAQ: /)]);
    }
    expect(canonicalTickerKey(await settleTypedListingKey("247540:KRX", market))).toBe("247540:KOSDAQ");
  } finally {
    UNSEARCHED.delete("247540");
  }
});

test("a row saved as 247540:KRX keeps its key, takes Gloom Cloud's KOSDAQ quote and says which board it read", async () => {
  // Saved before search listed EcoPro BM on KOSDAQ.
  const saved = createTestTicker("247540", "EcoPro BM Co., Ltd.", { exchange: "KRX", currency: "KRW" });
  const store = { loadTicker: async (key: string) => key === "247540" ? saved : null, loadAllTickers: async () => [saved] };
  requested = [];
  const run = createTestCliContext({ dataProvider, store });
  await marketDataCliCommands.find((command) => command.name === "quote")!.execute(["247540"], run.context);
  const { data, warnings } = run.printed[0]!.result;
  expect(data[0].target).toEqual({ symbol: "247540", exchange: "KRX" });
  expect(data[0].quote).toMatchObject({ listingExchangeName: "KRX", tradingExchangeName: "KOSDAQ" });
  expect(warnings).toEqual(["Read 247540:KRX on KOSDAQ, where 247540 trades."]);
});

test("a code that names two venues a symbol trades on both of asks which", async () => {
  LISTED.DUAL = [["TSX", "Dual Listed Corp"], ["JPX", "Dual Listed Corp"]];
  try {
    await expect(runCommand("quote", "DUAL:TSE")).rejects.toThrow(
      "TSE is Toronto Stock Exchange (TSX) or Tokyo Stock Exchange (JPX), and DUAL trades on TSX and JPX.",
    );
    await expect(openInCommandBar("DUAL:TSE")).rejects.toThrow("Multiple listings match DUAL:TSE");
  } finally {
    delete LISTED.DUAL;
  }
});

test("a function whose data covers US listings only names the company's US listing for a listing abroad, and leaves it out of a list", async () => {
  // Bare SAN in the US is Banco Santander: TAS SAN:EPA must not read its trades.
  await expect(runFunction("TAS", "SAN:EPA")).rejects.toThrow("Time and sales covers US listings only, and SAN:EPA is Sanofi on Euronext Paris (EPA).");
  // Time and sales also points at the finest bars the listing has, however the exchange is named.
  const minuteBars = (key: string) => `No second or tick bars; 1-minute bars: fn GIP ${key}; trades exist for US listings only.`;
  const refused = (token: string, typed: string, ...options: string[]) => runFunction(token, typed, ...options)
    .then(() => null, (error: { message: string; details?: string }) => [error.message, error.details]);
  for (const token of ["TAS", "QR"]) {
    for (const typed of [["SAN:EPA"], ["SAN", "--exchange", "EPA"]]) {
      expect(await refused(token, typed[0]!, ...typed.slice(1))).toEqual([
        "Time and sales covers US listings only, and SAN:EPA is Sanofi on Euronext Paris (EPA).",
        `Sanofi's US listing: SNY (try: gloomberb fn ${token} SNY)\n${minuteBars("SAN:EPA")}`,
      ]);
    }
  }
  expect((await refused("QR", "VOD", "--exchange", "LSE"))?.[1]).toBe(`No US listing of Vodafone Group was found.\n${minuteBars("VOD:LSE")}`);

  const list = await runFunction("SIW", "SAN:EPA,AAPL");
  expect(list.listing).toBe("AAPL");
  expect(list.warnings).toEqual([
    "FINRA short interest covers US listings only, and SAN:EPA is Sanofi on Euronext Paris (EPA). Sanofi's US listing: SNY (try: gloomberb fn SIW SNY)",
  ]);
});

test("a list function reads a pasted list split by semicolons, quote marks dropped, and names a separator left on its end", async () => {
  const list = await runFunction("SIW", `"AAPL";'RY' ;`);
  expect(list.listing).toBe("AAPL, RY");
  expect(list.warnings).toEqual(expect.arrayContaining(['Ignored the stray ";" after RY.']));
});
