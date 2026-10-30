import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../api-client/request";
import { createTestCliContext } from "../../test-support/cli-context";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";
import type { NewsArticle } from "../../news/types";
import { mapCloudNewsArticle } from "../../sources/gloomberb-cloud/news";
import { commonWordCandidate, newsSearchText, wordMeansMore } from "./news-search";
import { setCliWidthOverride } from "../../utils/cli-output";

const news = marketDataCliCommands.find((command) => command.name === "news")!;

afterEach(() => setCloudApiFetchTransport(null));

function story(id: string, headline: string, publishedAt: string) {
  return {
    id, headline, summary: "", topic: "energy", category: "energy", sentiment: "neutral", sectors: [],
    firstPublishedAt: publishedAt, lastPublishedAt: publishedAt, firstSeenAt: publishedAt, lastSeenAt: publishedAt,
    primaryUrl: `https://example.com/${id}`, primarySource: "wire", primaryPublisher: "Wire",
    variantCount: 1, sourceCount: 1, sources: ["wire"], entities: [], tickerLinks: [],
  };
}

/** Gloom Cloud answering /news/search with the stories, best match first; every requested URL is kept. */
function serveSearch(items: ReturnType<typeof story>[], match?: "all" | "closest") {
  const requests: URL[] = [];
  setCloudApiFetchTransport(async (url) => {
    requests.push(new URL(url));
    const closest = new URL(url).searchParams.get("closest") === "1";
    return new Response(JSON.stringify({ items, nextCursor: null, ...(closest && match ? { match } : {}) }), { headers: { "Content-Type": "application/json" } });
  });
  return requests;
}

const STORIES = [
  story("older", "Goldman holds TTF gas forecasts", "2026-06-17T06:13:14.000Z"),
  story("newer", "Goldman warns TTF could hit 105 euros", "2026-09-21T00:28:47.000Z"),
];

function render(printed: ReturnType<typeof createTestCliContext>["printed"][number]) {
  return serializeCliResult(printed.result, { ...DEFAULT_CLI_OPTIONS, format: "text", color: false }, printed.options)
    .replace(/\u001b\[[0-9;]*m/g, "");
}

/** A data provider for a symbol no listing answers to: no stories, no quote. */
function unknownSymbol() {
  const calls: string[] = [];
  const cli = createTestCliContext({
    dataProvider: {
      getNews: async () => { calls.push("news"); return []; },
      getQuote: async () => { throw new Error("Not a ticker: TTF."); },
    },
  });
  return { ...cli, calls };
}

test("several words, quoted or not, search story text without looking up a listing, and print the matches newest first", async () => {
  const requests = serveSearch(STORIES);
  const cli = createTestCliContext({ dataProvider: { getNews: async () => { throw new Error("no ticker lookup"); } } });
  await news.execute(["european gas"], cli.context);
  await news.execute(["european", "gas"], cli.context);

  expect(requests.map((url) => [url.pathname, url.searchParams.get("query"), url.searchParams.get("limit")]))
    .toEqual([["/news/search", "european gas", "20"], ["/news/search", "european gas", "20"]]);
  // The service answers headline hits first (an older one above a newer summary hit); the list reads newest first, as help says.
  expect((cli.printed[0]!.result.data as Array<{ id: string }>).map((article) => article.id)).toEqual(["newer", "older"]);
  expect(cli.printed[0]!.result.metadata).toMatchObject({ ticker: null, search: "european gas" });
  const text = render(cli.printed[0]!);
  expect(text.split("\n")[0]).toBe('Stories matching "european gas"');
  expect(text).toContain("Goldman warns TTF could hit 105 euros");
});

/**
 * `news ALL` on 30 Oct 2026 listed "September 2026 Monthly Release" with nothing under it: the $220M of
 * catastrophe losses were only in the JSON summary, and no row carried an id the story pane would open.
 */
test("each story prints its short id and its summary on one indented line cut to the width; exports keep both whole", async () => {
  const id = "7a2e8fda-0c4b-4c1e-9d55-2f4e8a6b1c3d";
  const summary = "Allstate estimated September catastrophe losses at $220 million,\n\nbringing third-quarter losses to $1.65 billion.";
  serveSearch([{ ...story(id, "September 2026 Monthly Release", "2026-10-15T11:52:00.000Z"), summary }]);
  const cli = createTestCliContext({ dataProvider: { getNews: async () => { throw new Error("no ticker lookup"); } } });
  await news.execute(["catastrophe losses"], cli.context);
  setCliWidthOverride(72);
  try {
    const lines = render(cli.printed[0]!).split("\n");
    const row = lines.findIndex((line) => line.includes("September 2026 Monthly Release"));
    expect(lines[row]).toContain("7a2e8fda");
    expect(lines[row]).not.toContain(id);
    expect(lines[row + 1]).toBe("  Allstate estimated September catastrophe losses at $220 million, brin…");
  } finally {
    setCliWidthOverride(null);
  }
  const csv = serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format: "csv", color: false }, cli.printed[0]!.options);
  expect(csv).toContain(id);
  expect((cli.printed[0]!.result.data as Array<{ summary: string }>)[0]!.summary).toBe(summary);
});

test("a search's undated stories go last, and stories of the same time keep the service's order", async () => {
  const at = "2026-10-15T13:10:00.000Z";
  serveSearch([
    story("undated-a", "Hashrate climbs as miners add machines", ""),
    story("tie-first", "Hashrate record at Foundry", at),
    story("older", "Hashrate falls after the halving", "2026-09-23T12:30:00.000Z"),
    story("tie-second", "Hashrate record at AntPool", at),
    story("undated-b", "Hashrate futures listed", ""),
    story("newest", "Hashrate index hits a high", "2026-10-15T13:11:00.000Z"),
  ]);
  const cli = createTestCliContext({ dataProvider: { getNews: async () => { throw new Error("no ticker lookup"); } } });
  await news.execute(["bitcoin hashrate"], cli.context);
  expect((cli.printed[0]!.result.data as Array<{ id: string }>).map((article) => article.id))
    .toEqual(["newest", "tie-first", "tie-second", "older", "undated-a", "undated-b"]);
});

test("a search no story has every word of lists the closest stories, and says so under its heading", async () => {
  const requests = serveSearch([
    story("two", "SpaceX lockup expiration puts buyers to the test", "2026-10-09T15:45:00.000Z"),
    story("one", "IPO calendar for the week", "2026-10-20T09:00:00.000Z"),
  ], "closest");
  const cli = createTestCliContext({ dataProvider: { getNews: async () => { throw new Error("no ticker lookup"); } } });
  await news.execute(["IPO lockup expiry"], cli.context);
  // The closest stories stay most words first, as the heading says, not by date.
  expect((cli.printed[0]!.result.data as Array<{ id: string }>).map((article) => article.id)).toEqual(["two", "one"]);

  expect(requests[0]!.searchParams.get("closest")).toBe("1");
  expect(cli.printed[0]!.result.metadata).toMatchObject({ search: "IPO lockup expiry", match: "closest" });
  const text = render(cli.printed[0]!);
  expect(text.split("\n")[0]).toBe('Stories matching "IPO lockup expiry"  ·  no story has every word of "IPO lockup expiry"; the closest, most words first');
  expect(text).toContain("SpaceX lockup expiration");

  // Stories with every word read as before.
  serveSearch(STORIES, "all");
  const all = createTestCliContext({ dataProvider: { getNews: async () => { throw new Error("no ticker lookup"); } } });
  await news.execute(["european gas"], all.context);
  expect(render(all.printed[0]!).split("\n")[0]).toBe('Stories matching "european gas"');
  expect(all.printed[0]!.result.metadata).not.toHaveProperty("match");
});

test("a word no listing answers to is searched as text, and says why under its heading", async () => {
  const requests = serveSearch(STORIES);
  const cli = unknownSymbol();
  await news.execute(["TTF"], cli.context);

  expect(requests.map((url) => url.searchParams.get("query"))).toEqual(["TTF"]);
  expect(render(cli.printed[0]!).split("\n")[0]).toBe('Stories matching "TTF"  ·  no ticker by that name');
  expect(cli.printed[0]!.result.data).toHaveLength(2);
});

test("a futures board code, which resolves to its future, is searched as text; a short one and a future with no commodity are not", async () => {
  const requests = serveSearch(STORIES);
  const future = (name: string) => createTestCliContext({
    dataProvider: { getNews: async () => [], getQuote: async () => ({ symbol: "TTF=F", name, instrumentType: "FUTURE", exchangeName: "NYM" }) },
  });
  const ttf = future("Dutch TTF Natural Gas Nov 26");
  await news.execute(["ttf"], ttf.context);
  expect(requests.map((url) => url.searchParams.get("query"))).toEqual(["ttf"]);
  expect(render(ttf.printed[0]!).split("\n")[0]).toBe('Stories matching "ttf"  ·  a futures code, not a ticker');

  const found = serveSearch([]);
  await news.execute(["ttf"], ttf.context);
  expect(render(ttf.printed[1]!)).toContain("No stories match TTF, and news is filed under company tickers, not futures; try news LNG.");

  // ZN is mostly a piece of other names, and ES=F has no commodity to search: both keep the futures answer.
  const treasury = future("10-Year T-Note Dec 26");
  await news.execute(["ZN"], treasury.context);
  await news.execute(["ES=F"], treasury.context);
  expect(found).toHaveLength(1);
  expect(render(treasury.printed[0]!)).toContain("news is filed under company tickers, not futures");
});

test("a commodity's future searches the stories of its commodity, and offers no route to itself when there are none", async () => {
  const requests = serveSearch(STORIES);
  const coffee = createTestCliContext({
    dataProvider: { getNews: async () => [], getQuote: async () => ({ symbol: "KC=F", name: "Coffee Dec 26", instrumentType: "FUTURE", exchangeName: "NYB" }) },
  });
  await news.execute(["KC=F"], coffee.context);
  expect(requests.map((url) => url.searchParams.get("query"))).toEqual(["coffee"]);
  expect(render(coffee.printed[0]!).split("\n")[0]).toBe('Stories matching "coffee"  ·  the commodity KC=F trades');

  const none = serveSearch([]);
  await news.execute(["KC=F"], coffee.context);
  expect(none).toHaveLength(1);
  expect(render(coffee.printed[1]!)).toContain("No news for Coffee Dec 26 (NYB): news is filed under company tickers, not futures");
});

test("a search no story matches says so, never a near miss, and offers the commodity's future only when its news has stories", async () => {
  // The service finds nothing for the text and one story for the commodity's own name.
  const requests: string[] = [];
  setCloudApiFetchTransport(async (url) => {
    const query = new URL(url).searchParams.get("query")!;
    requests.push(query);
    const items = query === "sugar" || query === "coffee" ? [STORIES[0]] : [];
    return new Response(JSON.stringify({ items, nextCursor: null }), { headers: { "Content-Type": "application/json" } });
  });
  const cli = unknownSymbol();
  await news.execute(["sugar prices"], cli.context);
  await news.execute(["arabica"], cli.context);
  await news.execute(["sugar", "beet", "pulp"], cli.context);
  await news.execute(["european gas"], cli.context);
  await news.execute(["palm oil"], cli.context);
  expect(render(cli.printed[0]!)).toContain('No stories match "sugar prices". For the Sugar #11 future, try: gloom news SB=F');
  expect(cli.printed[0]!.result.metadata).toMatchObject({ futuresNews: "gloom news SB=F" });
  expect(render(cli.printed[1]!)).toContain('No stories match "arabica". For the Coffee future, try: gloom news KC=F');
  expect(render(cli.printed[2]!)).toContain('No stories match "sugar beet pulp". For the Sugar #11 future');
  expect(render(cli.printed[3]!)).toContain('No stories match "european gas".');
  expect(render(cli.printed[3]!)).not.toContain("try:");
  // Palm oil is no crude: its search offers no WTI route.
  expect(render(cli.printed[4]!)).toContain('No stories match "palm oil".');
  expect(render(cli.printed[4]!)).not.toContain("try:");
  expect(requests).toEqual(["sugar prices", "sugar", "arabica", "coffee", "sugar beet pulp", "sugar", "european gas", "palm oil"]);

  // A route that would search what just found nothing, or that has no story either, is not offered.
  const quiet = serveSearch([]);
  await news.execute(['"sugar"'], cli.context);
  await news.execute(["cocoa prices"], cli.context);
  await news.execute(['"soybeans"'], cli.context);
  expect(render(cli.printed[5]!)).toContain('No stories match "sugar".');
  expect(render(cli.printed[6]!)).toContain('No stories match "cocoa prices".');
  expect(render(cli.printed[6]!)).not.toContain("news CC=F");
  expect(quiet.map((url) => url.searchParams.get("query"))).toEqual(["sugar", "cocoa prices", "cocoa", "soybeans"]);
});

test("a word whose story search fails says the search failed, with the lookup's answer, never that no story matches", async () => {
  const requests = serveSearch([]);
  setCloudApiFetchTransport(async (url) => {
    requests.push(new URL(url));
    return new Response("Search is down", { status: 503 });
  });
  const cli = unknownSymbol();
  await news.execute(["arabica"], cli.context);
  const text = render(cli.printed[0]!);
  expect(text).not.toContain("No stories match");
  expect(text).toContain("No listing answers to ARABICA. news takes a company ticker");
  expect(cli.printed[0]!.result.warnings).toEqual(['Searching stories for "arabica" failed: Search is down']);
  // No futures route is offered off a search that never answered.
  expect(requests).toHaveLength(1);
  expect(cli.printed[0]!.result.metadata).not.toHaveProperty("futuresNews");
});

test("a word nothing answers to and no story mentions keeps the not-a-ticker answer", async () => {
  serveSearch([]);
  const cli = unknownSymbol();
  await news.execute(["TTF"], cli.context);
  expect(render(cli.printed[0]!)).toContain("No stories match TTF, the futures board's code for Dutch TTF Gas. It is not a ticker: try news LNG.");

  // A search that cannot be made leaves the lookup's own answer rather than failing the command.
  setCloudApiFetchTransport(async () => new Response("{}", { status: 503 }));
  await news.execute(["ZZQXV"], cli.context);
  expect(render(cli.printed[1]!)).toContain("No listing answers to ZZQXV. news takes a company ticker");
});

test("a metal's future, name or bare board code is the metal's market news (NI METALS); the ticker in capitals keeps its company news", async () => {
  const requests = serveSearch(STORIES);
  const tickerNews: string[] = [];
  // GOLD is Gold.com Inc.; no listing answers to GC.
  const cli = createTestCliContext({
    dataProvider: {
      getNews: async (query: { ticker?: string }) => { tickerNews.push(query.ticker ?? ""); return []; },
      getQuote: async (symbol: string) => {
        if (symbol === "GOLD") return { symbol: "GOLD", name: "Gold.com Inc.", exchangeName: "NYSE" };
        throw new Error(`Not a ticker: ${symbol}.`);
      },
    },
  });
  for (const typed of ["GC=F", "SI=F", "hg=f", "PA=F", "gold", "Silver", "GC"]) await news.execute([typed], cli.context);

  expect(requests.map((url) => [url.searchParams.get("query"), url.searchParams.get("topics")])).toEqual([
    ["gold", "metals"], ["silver", "metals"], ["copper", "metals"], ["palladium", "metals"], ["gold", "metals"], ["silver", "metals"],
    ["gold", "metals"],
  ]);
  const headings = cli.printed.map((printed) => render(printed).split("\n")[0]);
  expect(headings).toEqual([
    'Metals news matching "gold"  ·  the commodity GC=F trades',
    'Metals news matching "silver"  ·  the commodity SI=F trades',
    'Metals news matching "copper"  ·  the commodity HG=F trades',
    'Metals news matching "palladium"  ·  the commodity PA=F trades',
    'Metals news matching "gold"',
    'Metals news matching "silver"',
    'Metals news matching "gold"  ·  GC is the futures board\'s code for Gold',
  ]);
  expect(cli.printed[4]!.result.metadata).toMatchObject({ ticker: null, search: "gold", topics: ["metals"], companyNews: "gloom news GOLD" });
  expect(render(cli.printed[4]!)).toContain("gold → gold's market news. For Gold.com Inc. (ticker GOLD), try: gloom news GOLD");
  // No ticker is SILVER here, so none is offered.
  expect(cli.printed[5]!.result.metadata).not.toHaveProperty("companyNews");

  // GOLD in capitals is the ticker: its company news, no metals search.
  await news.execute(["GOLD"], cli.context);
  expect(requests).toHaveLength(7);
  expect(tickerNews).toEqual(["GC", "GOLD"]);
  expect(render(cli.printed[7]!).split("\n")[0]).toContain("Gold.com Inc.");

  // No story tagged METALS: every story that names the metal is one search away.
  serveSearch([]);
  await news.execute(["PL=F"], cli.context);
  expect(render(cli.printed[8]!)).toContain(`No metals stories match "platinum". For every story that mentions it, try: gloom news '"platinum"'`);
});

test("a real listing, with or without stories, never falls back to a text search", async () => {
  const requests = serveSearch(STORIES);
  const quiet = createTestCliContext({
    dataProvider: { getNews: async () => [], getQuote: async () => ({ symbol: "ACME", name: "Acme Corp", exchangeName: "NYSE" }) },
  });
  await news.execute(["ACME"], quiet.context);
  expect(render(quiet.printed[0]!)).toContain("No news for Acme Corp (NYSE).");

  // --exchange and --feed name a listing or a feed: they keep the lookup's own answer too.
  const unknown = unknownSymbol();
  await news.execute(["TTF", "--exchange", "NYSE"], unknown.context);
  await news.execute(["TTF", "--feed", "top"], unknown.context);
  expect(requests).toHaveLength(0);
});

test("a coin pair whose stories came from searching the coin says so, with the name its quote gives to search", async () => {
  const queries: Array<{ ticker?: string; listingName?: string }> = [];
  const cli = createTestCliContext({
    dataProvider: {
      getNews: async (query) => {
        queries.push({ ticker: query.ticker, listingName: query.listingName });
        return [{ ...mapCloudNewsArticle(story("btc", "Bitcoin snaps back after a failed downside break", "2026-10-15T09:00:00.000Z")), searchedFor: "hyperliquid" }];
      },
      getQuote: async () => ({ symbol: "HYPE32196-USD", name: "Hyperliquid USD", exchangeName: "CCC", instrumentType: "CRYPTOCURRENCY" }),
    },
  });
  await news.execute(["HYPE32196-USD"], cli.context);

  expect(queries).toEqual([{ ticker: "HYPE32196-USD", listingName: "Hyperliquid USD" }]);
  const text = render(cli.printed[0]!);
  expect(text.split("\n")[0]).toBe('Stories matching "hyperliquid"  ·  no stories filed under HYPE32196-USD');
  expect(text).toContain("Bitcoin snaps back");
  expect(cli.printed[0]!.result.metadata).toMatchObject({ ticker: "HYPE32196-USD", search: "hyperliquid" });
});

test("text search refuses a symbol's options and text the service would reject", async () => {
  const requests = serveSearch(STORIES);
  const cli = createTestCliContext();
  await expect(news.execute(["european gas", "--feed", "top"], cli.context)).rejects.toThrow("--feed goes with a symbol");
  await expect(news.execute(["gas", "gas", "--exchange", "NYSE"], cli.context)).rejects.toThrow("--exchange goes with a symbol");
  await expect(news.execute(["+ -"], cli.context)).rejects.toThrow("Search text needs at least two characters");
  expect(requests).toHaveLength(0);
});

test("only several words, or one that kept its quotes, are text up front; a bare word stays a symbol", () => {
  expect(newsSearchText([])).toBeNull();
  expect(newsSearchText(["TTF"])).toBeNull();
  expect(newsSearchText(["european gas"])).toBe("european gas");
  expect(newsSearchText(["european", "  gas "])).toBe("european gas");
  // A shell drops one pair of quotes: news '"gold"' arrives as "gold" and searches the text.
  expect(newsSearchText(['"gold"'])).toBe("gold");
});

test("a word that is also its company's name hints at the text search only when its stories are mostly elsewhere", () => {
  const filed = (tickers: string[]) => ({ tickers }) as unknown as NewsArticle;
  expect(commonWordCandidate("gold", "Gold.com Inc.")).toBe(true);
  // Typed as a ticker, or not a word of the name: no lookup of the stories at all.
  expect(commonWordCandidate("GOLD", "Gold.com Inc.")).toBe(false);
  expect(commonWordCandidate("tsla", "Tesla, Inc.")).toBe(false);
  expect(wordMeansMore([filed([]), filed(["NEM"]), filed(["GOLD"])], "GOLD")).toBe(true);
  expect(wordMeansMore([filed(["META"]), filed(["META", "GOOGL"]), filed([])], "META")).toBe(false);
  expect(wordMeansMore([filed([]), filed([])], "GOLD")).toBe(false);
});
