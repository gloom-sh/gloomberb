import { describe, expect, test } from "bun:test";
import type { PaneFunctionCatalog } from "../../../../cli/pane-functions/catalog";
import type { PaneDef, PaneTemplateDef } from "../../../../types/plugin";
import type { MarketContext } from "../../../../cli/types";
import { createDefaultConfig } from "../../../../types/config";
import { getLoadablePlugins } from "../../../catalog";
import { sourceShare } from "./host";
import type { ASKGToolRow, ASKGTurn } from "./model";
import type { JsonValue } from "./protocol";
import {
  answerReadNothing,
  answerSources,
  answerWithSourceLinks,
  citedRefs,
  createSourceResolver,
  formatSourceCommand,
  linkCitations,
  MAPPED_SERVER_TOOLS,
  serverToolCommand,
  sourceRefFromHref,
  type ASKGSourceTarget,
} from "./sources";

function builtInCatalog(): PaneFunctionCatalog {
  const panes = new Map<string, PaneDef>();
  const paneTemplates = new Map<string, PaneTemplateDef>();
  for (const plugin of getLoadablePlugins()) {
    for (const entry of plugin.panes ?? []) panes.set(entry.id, entry);
    for (const entry of plugin.paneTemplates ?? []) paneTemplates.set(entry.id, entry);
  }
  return { panes, paneTemplates, destroy() {} };
}

const resolver = createSourceResolver(builtInCatalog());

function row(name: string, args: Record<string, JsonValue>, patch: Partial<ASKGToolRow> = {}): ASKGToolRow {
  return {
    toolCallId: `${name}:${JSON.stringify(args)}`,
    name,
    argumentSummary: "",
    args,
    writeTier: "read",
    origin: "server",
    status: "ok",
    requiresConfirmation: false,
    expanded: false,
    ...patch,
  };
}

function opens(target: ASKGSourceTarget): string | null {
  return target.kind === "pane" ? formatSourceCommand(target.command) : null;
}

function server(name: string, args: Record<string, JsonValue>): string | null {
  const command = serverToolCommand(name, args);
  return command ? formatSourceCommand(command) : null;
}

describe("the function a read's data is shown in", () => {
  test("a call the platform ran opens the function that shows it, run on what it read", () => {
    expect(server("market.quotes", { symbols: ["nvda", "AMD"] })).toBe("QQ NVDA,AMD");
    // No dates: the window that holds the bars it asked for, at their size.
    expect(server("market.history", { symbol: "NVDA", interval: "1day", limit: 120 })).toBe("HP NVDA --range 6M");
    expect(server("market.history", { symbol: "NVDA", interval: "1day", limit: 250 })).toBe("HP NVDA --range 1Y");
    expect(server("market.history", { symbol: "NVDA", interval: "5min" })).toBe("HP NVDA --range 1D");
    expect(server("market.history", { symbol: "NVDA", interval: "1week" })).toBe("HP NVDA --range 5Y");
    expect(server("market.history", { symbol: "NVDA", startDate: "2026-01-02", endDate: "2026-06-30" }))
      .toBe("HP NVDA --from 2026-01-02 --to 2026-06-30");
    expect(server("company.statements", { symbol: "AAPL", period: "quarterly" })).toBe("FA AAPL --period quarterly");
    expect(server("company.statements", { symbol: "AAPL", period: "both" })).toBe("FA AAPL");
    expect(server("market.options_chain", { symbol: "NVDA", expiration: "2026-12-18" })).toBe("OMON NVDA --expiration 2026-12-18");
    expect(server("market.screener", { category: "most-active" })).toBe("MOST --list actives");
    expect(server("sec.filings", { ticker: "TSLA" })).toBe("SEC TSLA");
    expect(server("macro.series", { seriesId: "unrate" })).toBe("G FRED:UNRATE");
    expect(server("congress.senate_trades", {})).toBe("CG --chamber senate");
    // A listing abroad is written as the app writes one.
    expect(server("company.profile", { symbol: "SAN", exchange: "EPA" })).toBe("T SAN:EPA");
    expect(server("news.stories", { tickers: ["AAPL"] })).toBe("CN AAPL");
    expect(server("news.stories", { feed: "top" })).toBe("TOP");
  });

  test("a call no pane lists as such has no source to open", () => {
    // A search reads stories no feed shows; several tickers read no one ticker's news.
    expect(server("news.stories", { query: "fed minutes" })).toBeNull();
    expect(server("news.stories", { tickers: ["AAPL", "MSFT"] })).toBeNull();
    expect(server("market.search", { query: "nvidia" })).toBeNull();
    expect(server("market.history", {})).toBeNull();
    expect(server("some.future_tool", { symbol: "NVDA" })).toBeNull();
  });

  test("every tool the table places opens a function this app has, as written", () => {
    const samples: Record<string, Record<string, JsonValue>> = {
      "market.quotes": { symbols: ["NVDA", "AMD"] },
      "market.history": { symbol: "NVDA", interval: "1day" },
      "market.screener": { category: "gainers" },
      "company.profile": { symbol: "NVDA" },
      "company.statements": { symbol: "NVDA", period: "quarterly" },
      "company.financials": { symbol: "NVDA" },
      "company.holders": { symbol: "NVDA" },
      "company.analyst_research": { symbol: "NVDA" },
      "company.corporate_actions": { symbol: "NVDA" },
      "market.options_chain": { symbol: "NVDA", expiration: "2026-12-18" },
      "sec.filings": { ticker: "NVDA" },
      "sec.insider_transactions": { ticker: "NVDA" },
      "sec.thirteenf_holders": { ticker: "NVDA" },
      "macro.calendar": {},
      "macro.series": { seriesId: "UNRATE" },
      "macro.yield_curve": {},
      "congress.house_trades": { ticker: "NVDA" },
      "congress.senate_trades": {},
      "market.short_interest": { symbol: "NVDA" },
      "market.options_flow": { symbol: "NVDA" },
      "news.stories": { tickers: ["NVDA"] },
      "social.ticker_posts": { ticker: "NVDA" },
      "equity.diagnostic": { symbol: "NVDA" },
      "company.hiring": { ticker: "NVDA" },
      "hiring.momentum": { symbol: "NVDA" },
      "apps.attention": { symbol: "META" },
    };
    expect(Object.keys(samples).sort()).toEqual([...MAPPED_SERVER_TOOLS].sort());
    const unopened = MAPPED_SERVER_TOOLS.filter((name) => resolver.target(row(name, samples[name]!)).kind !== "pane");
    expect(unopened).toEqual([]);
  });

  test("a call this app ran opens its own function, with its argument and the options the pane draws", () => {
    const client = (name: string, args: Record<string, JsonValue>) => opens(resolver.target(row(name, args, { origin: "client" })));
    expect(client("hp", { symbol: "NVDA", range: "1Y" })).toBe("HP NVDA --range 1Y");
    expect(client("gp", { symbol: "NVDA", rangePreset: "5Y" })).toBe("GP NVDA --range-preset 5Y");
    expect(client("fa", { symbol: "AAPL", period: "quarterly", statement: "balance" }))
      .toBe("FA AAPL --period quarterly --statement balance");
    // `--limit` cuts the rows a report reads, not what the pane shows.
    expect(client("si", { symbol: "NVDA", limit: 10 })).toBe("SI NVDA");
  });

  test("never a link the app would not open as written", () => {
    // An option the function does not have, or a value it does not list.
    expect(resolver.target(row("hp", { symbol: "NVDA", window: "1Y" }, { origin: "client" })).kind).toBe("none");
    expect(resolver.target(row("hp", { symbol: "NVDA", range: "7Y" }, { origin: "client" })).kind).toBe("none");
    // A write, app state and a tool the app does not have.
    expect(resolver.target(row("watchlist.add", { symbol: "NVDA" }, { origin: "client", writeTier: "user-data" })).kind).toBe("none");
    expect(resolver.target(row("app.get_resource", { resource: "app://accounts" }, { origin: "client" })).kind).toBe("none");
    expect(resolver.target(row("nosuchfn", { symbol: "NVDA" }, { origin: "client" })).kind).toBe("none");
    expect(createSourceResolver(null).target(row("market.quotes", { symbols: ["NVDA"] })).kind).toBe("none");
  });

  test("a call kept without its arguments opens only a pane its arguments could not change", () => {
    // A transcript from before the platform kept them, or arguments too large
    // to send: a news search or one chamber's trades in a ticker would
    // otherwise open the whole feed.
    const bare = (name: string, origin: ASKGToolRow["origin"] = "server") => {
      const { args: _args, ...kept } = row(name, {}, { origin });
      return opens(resolver.target(kept));
    };
    expect(bare("news.stories")).toBeNull();
    expect(bare("congress.house_trades")).toBeNull();
    expect(bare("congress.senate_trades")).toBeNull();
    expect(bare("hp", "client")).toBeNull();
    expect(bare("macro.calendar")).toBe("ECO");
    expect(bare("macro.yield_curve")).toBe("GC");
    // A call that sent its arguments, even none, says what it read.
    expect(opens(resolver.target(row("news.stories", {})))).toBe("N");
  });
});

describe("citations", () => {
  test("an answer cites sources after its figures, never in code or a link's label", () => {
    const answer = "NVDA closed at **$182.10** [3], up 2% [3][5]. Revenue rose [6, 7]. See `[8]`, [9](https://example.com) and \\[10].";
    expect(citedRefs(answer)).toEqual([3, 5, 6, 7]);
  });

  test("a citation that opens a pane becomes a link; one that opens nothing stays text", () => {
    const linked = linkCitations("Up 2% [3][5]. Revenue rose [6, 7]. See `[3]`.", new Set([3, 6]));
    expect(linked).toBe("Up 2% [ 3 ](gloom-source:3)[5]. Revenue rose [ 6 ](gloom-source:6)\\[7\\]. See `[3]`.");
    expect(linkCitations("Up 2% [3].", new Set())).toBe("Up 2% [3].");
    expect(sourceRefFromHref("gloom-source:6")).toBe(6);
    expect(sourceRefFromHref("https://example.com")).toBeNull();
    expect(sourceRefFromHref("gloom-source:0")).toBeNull();
  });

  test("a source link the answer wrote itself shows the number of the source it opens", () => {
    const written = "Up 2% [ 9 ](gloom-source:2), down [x](gloom-source:nope).";
    expect(citedRefs(written)).toEqual([2]);
    expect(linkCitations(written, new Set([2]))).toBe("Up 2% [ 2 ](gloom-source:2), down x.");
    expect(linkCitations(written, new Set())).toBe("Up 2% [2], down x.");
    expect(answerWithSourceLinks(written, [{ label: "[2] HP NVDA", url: "https://x" }]))
      .toBe("Up 2% [2], down x.\n\n[2] HP NVDA https://x");
  });
});

describe("the sources an answer lists", () => {
  function turn(id: string, answer: string, tools: ASKGToolRow[]): ASKGTurn {
    return { id, remoteTurnId: id, prompt: "q", answer, tools, status: "complete", error: null, startedAt: 0 };
  }
  const quotes = row("market.quotes", { symbols: ["NVDA"] }, { ref: 1 });
  const history = row("market.history", { symbol: "NVDA", interval: "1day" }, { ref: 2 });
  const posts = row("social.search_posts", { query: "nvidia" }, { ref: 3 });

  test("a follow-up can cite what an earlier answer read; a number no read carries opens nothing", () => {
    const turns = [
      turn("a", "NVDA is at $182 [1].", [quotes]),
      turn("b", "It is up 40% this year [2] from $130 [1]; posts are upbeat [3]; volume [9].", [history, posts]),
    ];
    const sources = answerSources(turns, 1, resolver);
    expect(sources.map((source) => [source.ref, source.row?.toolCallId ?? null, opens(source.target)])).toEqual([
      [2, history.toolCallId, "HP NVDA --range 6M"],
      [1, quotes.toolCallId, "QQ NVDA"],
      [3, posts.toolCallId, null],
      [9, null, null],
    ]);
  });

  test("an answer that cites nothing lists what its own turn read", () => {
    const failed = row("company.holders", { symbol: "NVDA" }, { status: "error" });
    const sources = answerSources([turn("a", "NVDA is at $182.", [quotes, failed, posts])], 0, resolver);
    expect(sources.map((source) => opens(source.target))).toEqual(["QQ NVDA"]);
  });

  test("an answer with figures that read nothing says so, on a turn the server numbered", () => {
    const numbered = (answer: string, tools: ASKGToolRow[]) => answerReadNothing({ ...turn("a", answer, tools), numbered: true });
    expect(numbered("Apple was founded in 1976.", [])).toBe(true);
    expect(numbered("Hello! Ask me about a ticker.", [])).toBe(false);
    expect(numbered("NVDA is at $182 [1].", [])).toBe(false);
    expect(numbered("NVDA is at $182.", [quotes])).toBe(false);
    // An app action had its reason to answer without data.
    expect(numbered("Opened NVDA on 6M.", [row("chart.open", { symbol: "NVDA" }, { origin: "client", writeTier: "ui-write" })])).toBe(false);
    // An older server's answer, or a stored one, may have read what it no longer shows.
    expect(answerReadNothing(turn("a", "Apple was founded in 1976.", []))).toBe(false);
  });
});

describe("the pane share a source opens", () => {
  // The share is what opens the pane, so the view the figure was read from
  // has to survive the share's privacy filter and its validation.
  const context = { config: createDefaultConfig("/tmp/gloomberb-askg-sources-test") } as MarketContext;

  test("carries the pane on the read's ticker and options, titled with the words that open it", async () => {
    const source = serverToolCommand("market.history", { symbol: "nvda", interval: "1day", limit: 126 })!;
    const share = await sourceShare(builtInCatalog(), context, source);
    expect(share.data.title).toBe("HP NVDA --range 6M");
    if (share.data.version !== 2) throw new Error("expected a portable pane share");
    const [instance] = share.data.layout.layout.instances;
    expect(instance).toMatchObject({ binding: { kind: "fixed", symbol: "NVDA" } });
    expect(JSON.stringify(instance?.settings)).toContain("6M");
  });

  test("keeps an option a pane holds in its view state", async () => {
    const source = serverToolCommand("company.statements", { symbol: "AAPL", period: "quarterly" })!;
    const share = await sourceShare(builtInCatalog(), context, source);
    if (share.data.version !== 2) throw new Error("expected a portable pane share");
    expect(JSON.stringify(share.data.layout.paneState)).toContain("quarterly");
  });
});
