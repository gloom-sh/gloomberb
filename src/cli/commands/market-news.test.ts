import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../api-client/request";
import { createTestCliContext } from "../../test-support/cli-context";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";
import type { NewsArticle } from "../../news/types";
import { commonWordCandidate, newsSearchText, wordMeansMore } from "./news-search";

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
function serveSearch(items: ReturnType<typeof story>[]) {
  const requests: URL[] = [];
  setCloudApiFetchTransport(async (url) => {
    requests.push(new URL(url));
    return new Response(JSON.stringify({ items, nextCursor: null }), { headers: { "Content-Type": "application/json" } });
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

test("several words, quoted or not, search story text newest first without looking up a listing", async () => {
  const requests = serveSearch(STORIES);
  const cli = createTestCliContext({ dataProvider: { getNews: async () => { throw new Error("no ticker lookup"); } } });
  await news.execute(["european gas"], cli.context);
  await news.execute(["european", "gas"], cli.context);

  expect(requests.map((url) => [url.pathname, url.searchParams.get("query"), url.searchParams.get("limit")]))
    .toEqual([["/news/search", "european gas", "20"], ["/news/search", "european gas", "20"]]);
  expect((cli.printed[0]!.result.data as Array<{ id: string }>).map((article) => article.id)).toEqual(["newer", "older"]);
  expect(cli.printed[0]!.result.metadata).toMatchObject({ ticker: null, search: "european gas" });
  const text = render(cli.printed[0]!);
  expect(text.split("\n")[0]).toBe('Stories matching "european gas"');
  expect(text).toContain("Goldman warns TTF could hit 105 euros");
});

test("a word no listing answers to is searched as text, and says why under its heading", async () => {
  const requests = serveSearch(STORIES);
  const cli = unknownSymbol();
  await news.execute(["TTF"], cli.context);

  expect(requests.map((url) => url.searchParams.get("query"))).toEqual(["TTF"]);
  expect(render(cli.printed[0]!).split("\n")[0]).toBe('Stories matching "TTF"  ·  no ticker by that name');
  expect(cli.printed[0]!.result.data).toHaveLength(2);
});

test("a futures board code, which resolves to its future, is searched as text; a short one and a contract symbol are not", async () => {
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

  // ZN matches names that merely contain it, and CL=F is a contract, not a word: both keep the futures answer.
  const treasury = future("10-Year T-Note Dec 26");
  await news.execute(["ZN"], treasury.context);
  await news.execute(["CL=F"], treasury.context);
  expect(found).toHaveLength(1);
  expect(render(treasury.printed[0]!)).toContain("news is filed under company tickers, not futures");
});

test("a word nothing answers to and no story mentions keeps the not-a-ticker answer", async () => {
  serveSearch([]);
  const cli = unknownSymbol();
  await news.execute(["TTF"], cli.context);
  expect(render(cli.printed[0]!)).toContain("No stories match TTF, the futures board's code for Dutch TTF Gas. It is not a ticker: try news LNG.");

  // A search that cannot be made leaves the lookup's own answer rather than failing the command.
  setCloudApiFetchTransport(async () => new Response("{}", { status: 503 }));
  await news.execute(["ZZQXV"], cli.context);
  expect(render(cli.printed[1]!)).toContain("No listing answers to ZZQXV and no stories match it.");
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
