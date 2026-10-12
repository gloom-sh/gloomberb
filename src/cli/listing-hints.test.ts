import { expect, test } from "bun:test";
import { createTestCliContext } from "../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import { marketDataCliCommands } from "./commands/market";
import { indexRootFor, indexRootTryLine } from "./index-roots";
import {
  futuresTryLine, ListingArgError, listingChoiceNote, parseListingArg, quoteBareListing, quotedListingChoiceNotes, resolveCliListing, type ListingVenue,
} from "./listing-arg";
import { createTestArticle } from "../test-support/news";
import { DEFAULT_CLI_OPTIONS } from "./options";
import { serializeCliResult } from "./result";

const SEARCH: Record<string, Array<[string, string]>> = {
  "2222": [["JPX", "Kotobuki Spirits Co., Ltd."], ["TADAWUL", "Saudi Arabian Oil Co."]],
  CAR: [["NASDAQ", "Avis Budget Group Inc."], ["XETRA", "Carrefour SA"]],
};

const dataProvider = createTestDataProvider({
  search: async (query) => (SEARCH[query] ?? []).map(([exchange, name]) => ({
    providerId: "test", symbol: query, name, exchange, type: "Common Stock", currency: "USD",
  })),
  getQuote: async (symbol, exchange) => {
    if (symbol !== "CAR:ASX") throw new Error(`No quote for ${symbol}`);
    return createTestQuote({ symbol: "CAR.AX", name: "CAR Group Limited", currency: "AUD", listingExchangeName: exchange });
  },
  // The source spells the listing its own way (CAR.AX), which `fn` does not take.
  getHolders: async () => ({ symbol: "CAR.AX", holders: [{ ownerType: "institution", name: "Pacer Advisors, Inc.", shares: 387 }] }),
  // One Form 4 of the company's own, so insider points at them.
  getSecFilings: async () => [{
    accessionNumber: "0000000000-26-000001", form: "4", filingDate: new Date("2026-09-01"), cik: "1", filingUrl: "https://www.sec.gov/",
  }],
  getSecFilingContent: async () => { throw new Error("unread"); },
});
const deps = { store: { loadTicker: async () => null, loadAllTickers: async () => [] }, dataProvider };

/** Each `gloomberb ...` command a hint suggests, as the words typed. */
function suggestedCommands(text: string): string[][] {
  return [...text.matchAll(/gloomberb ([^()`\n]+)/g)].map((match) => match[1]!.trim().replace(/\.$/, "").split(/\s+/));
}

/** The listing a suggested command names, as the command itself reads it. */
async function suggestedListing(words: string[]): Promise<string> {
  const [command, ...rest] = words;
  const exchangeAt = rest.indexOf("--exchange");
  const exchange = exchangeAt >= 0 ? rest[exchangeAt + 1] : undefined;
  // `fn INS CAR:ASX` takes its listing after the function.
  const symbol = command === "fn" ? rest[1]! : rest[0]!;
  return (await resolveCliListing(symbol, exchange, deps)).key;
}

test("every command a hint suggests runs on the listing it names", async () => {
  const hints: Array<{ text: string; listings: string[] }> = [];

  // The listings a bare code several companies use asks between, each with its retry.
  const choose = await quoteBareListing(await resolveCliListing("2222", undefined, deps), deps, { command: "history --range 5Y", noun: "history" });
  hints.push({ text: choose?.kind === "missing" ? choose.details : "", listings: ["2222:JPX", "2222:TADAWUL"] });
  // A futures board code's future, and an index root's index.
  hints.push({ text: futuresTryLine("GC", { command: "quote", noun: "quote" }) ?? "", listings: ["GC=F"] });
  hints.push({ text: indexRootTryLine(indexRootFor("VIX")!), listings: ["^VIX"] });
  // Too many companies to name on one line point at search.
  const venues: ListingVenue[] = ["NASDAQ", "XETRA", "ASX", "JSE", "LSE", "WSE", "HKEX"].map((exchange, index) => ({ exchange, name: `Company ${index}` }));
  hints.push({ text: listingChoiceNote("CAR", { exchange: "NASDAQ" }, venues) ?? "", listings: [] });

  // insider's pointer to Form 4 transactions names the listing as the command read it, not CAR.AX.
  const run = createTestCliContext({ dataProvider });
  await marketDataCliCommands.find((command) => command.name === "insider")!.execute(["CAR:ASX"], run.context);
  const printed = run.printed[0]!;
  hints.push({ text: serializeCliResult(printed.result, DEFAULT_CLI_OPTIONS, printed.options), listings: ["CAR:ASX"] });

  for (const { text, listings } of hints) {
    const commands = suggestedCommands(text);
    expect(commands.length).toBeGreaterThan(0);
    const named = commands.filter(([command]) => command !== "search");
    expect(await Promise.all(named.map(suggestedListing))).toEqual(listings);
    for (const [, query] of commands.filter(([command]) => command === "search")) expect(query).toBe("CAR");
  }

  // Two spellings of one listing that disagree name both, and each runs.
  const conflict = (() => {
    try {
      return parseListingArg("SAN:EPA", "LSE");
    } catch (error) {
      return error as ListingArgError;
    }
  })() as ListingArgError;
  const forms = /as (\S+) or (\S+) --exchange (\S+)\./.exec(conflict.details ?? "")!;
  expect((await resolveCliListing(forms[1]!, undefined, deps)).key).toBe("SAN:EPA");
  expect((await resolveCliListing(forms[2]!, forms[3], deps)).key).toBe("SAN:LSE");
});

// Decided per command (GLO-549): `fn` reports are titled by function and symbol, so a bare
// symbol several companies list gets quote's line; `news` heads its table with the listing.
test("a bare symbol several companies list is named once per report: fn by quote's line, news by its heading", async () => {
  const provider = createTestDataProvider({
    search: dataProvider.search,
    getQuote: async (symbol, exchange) => symbol === "CAR" && !exchange
      ? createTestQuote({ symbol: "CAR", name: "Avis Budget Group, Inc.", currency: "USD", listingExchangeName: "NASDAQ" })
      : dataProvider.getQuote(symbol, exchange),
    getNews: async () => [createTestArticle("avis", { title: "Avis results", tickers: ["CAR"] })],
  });
  const market = { ...deps, dataProvider: provider };
  expect(await quotedListingChoiceNotes(await resolveCliListing("CAR", undefined, market), market))
    .toEqual(["CAR = Avis Budget Group, NASDAQ (also XETRA)"]);
  expect(await quotedListingChoiceNotes(await resolveCliListing("CAR:ASX", undefined, market), market)).toEqual([]);

  const run = createTestCliContext({ dataProvider: provider });
  await marketDataCliCommands.find((command) => command.name === "news")!.execute(["CAR"], run.context);
  const printed = run.printed[0]!;
  expect(printed.result.warnings).toBeUndefined();
  expect(serializeCliResult(printed.result, DEFAULT_CLI_OPTIONS, printed.options).split("\n")[0]).toContain("Avis Budget Group, Inc.");
});
