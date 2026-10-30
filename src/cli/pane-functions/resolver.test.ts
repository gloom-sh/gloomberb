import { expect, mock, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { getLoadablePlugins } from "../../plugins/catalog";
import { centralBankRatesModule } from "../../plugins/builtin/central-bank-rates";
import { chartComposerModule } from "../../plugins/builtin/chart-composer";
import { creditBoardsModule } from "../../plugins/builtin/credit-boards";
import { ivHistoryModule } from "../../plugins/builtin/iv-history";
import { volSurfaceModule } from "../../plugins/builtin/vol-surface";
import { earningsCallsHeadless } from "../../plugins/builtin/earnings-calls/headless";
import { ipoCalendarPlugin } from "../../plugins/builtin/ipo-calendar";
import { ratePathModule } from "../../plugins/builtin/rate-path";
import { paneSchemas } from "../../plugins/builtin/chart-composer/headless-schema";
import { createDefaultConfig } from "../../types/config";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../../types/plugin";
import type { MarketContext } from "../types";
import { buildPaneCatalogEntries, type PaneFunctionCatalog } from "./catalog";
import { createPaneCatalog } from "./discovery";
import { buildFunctionReport } from "./report";
import { buildCreateOptions, parsePaneFunctionArgs } from "./options";
import { applyListingArgument, findPaneFunction, parsePaneFunctionArgsFor, resolvePaneFunction, UnknownPaneFunctionError, withTickerList } from "./resolver";
import { getHeadlessPaneDefinition } from "./capabilities";
import { tickerDetailModule } from "../../plugins/builtin/ticker-detail";
import { earningsModule } from "../../plugins/builtin/earnings";
import { dividendYieldModule } from "../../plugins/builtin/dividend-yield";
import { portfolioRiskHeadless } from "../../plugins/builtin/analytics/risk-headless";
import { capabilityPluginState } from "./capabilities";
import { newsWireModule } from "../../plugins/builtin/news/wire";
import { shortStoryId, storyIdMatches } from "../../news/story-id";

const pane = (id: string): PaneDef => ({ id, name: id, component: () => null, defaultPosition: "right" });
const template = (prefix: string, paneId: string, headless: HeadlessPaneDefinition): PaneTemplateDef => ({
  id: `${paneId}-pane`, paneId, label: prefix, description: prefix, shortcut: { prefix, argPlaceholder: "", argKind: "ticker" }, headless,
});
const indices: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "none" }, options: [], load: () => ({ sections: [] }),
};
const intraday: HeadlessPaneDefinition<"series"> = {
  shape: "series", ...paneSchemas["graph-intraday-price-pane"], load: () => ({ series: [] }),
};
const registry: PaneFunctionCatalog = {
  panes: new Map([["world-indices", pane("world-indices")], ["earnings-calls", pane("earnings-calls")], ["chart", pane("chart")], ["analytics", pane("analytics")]]),
  paneTemplates: new Map([
    ["world-indices-pane", template("WEI", "world-indices", indices)],
    ["earnings-calls-pane", template("CALLS", "earnings-calls", earningsCallsHeadless)],
    ["chart-pane", template("GIP", "chart", intraday)],
    ["analytics-pane", template("MARS", "analytics", portfolioRiskHeadless)],
  ]),
  destroy: () => {},
};
const context = { config: createDefaultConfig("/tmp/gloomberb-resolver-test") } as MarketContext;
const fn = (args: string[], tableSection = true) => resolvePaneFunction(
  registry, context, parsePaneFunctionArgs(args), { strictHeadlessOptions: true, tableSection },
);

test("--section picks a report table, unless the function has a section option of its own", async () => {
  const board = await fn(["WEI", "--section", "Europe"]);
  expect(board.tableSection).toBe("Europe");
  expect(board.options).not.toHaveProperty("section");
  // CALLS reads --section as the transcript part, as before.
  const transcript = await fn(["CALLS", "NVDA", "--section", "q&a"]);
  expect(transcript.tableSection).toBeUndefined();
  expect(transcript.options.section).toBe("qa");
  await expect(fn(["CALLS", "NVDA", "--section", "bogus"])).rejects.toThrow("Invalid --section value");
  // Screenshots have no tables to pick from.
  await expect(fn(["WEI", "--section", "Europe"], false)).rejects.toThrow("WEI does not support --section");
});

test("a pair option reads the words after its flag, and a refused option is named as it was typed", async () => {
  const args = ["MARS", "book", "--view", "stress", "--fx-shift", "TRY", "-20,", "EUR", "5", "--asset-shift", "BTC-USD", "-30"];
  const parsed = parsePaneFunctionArgsFor(registry, args);
  expect(parsed.arg).toBe("book");
  const resolved = await resolvePaneFunction(registry, context, parsed, { strictHeadlessOptions: true });
  expect(resolved.options).toMatchObject({ view: "stress", "fx-shift": "TRY -20, EUR 5", "asset-shift": "BTC-USD -30" });
  // A decimal comma ends the value like any number: the next word is the argument.
  const decimal = parsePaneFunctionArgsFor(registry, ["MARS", "--fx-shift", "TRY", "-2,5", "book"]);
  expect([decimal.arg, decimal.options.fxShift]).toEqual(["book", "TRY -2,5"]);
  // A function without pair options reads the word after the value as its argument, as before.
  expect(parsePaneFunctionArgsFor(registry, ["WEI", "--fx-shift", "TRY", "-20"]).arg).toBe("-20");
  // A refused flag reads as typed, not as the parser keys it (--fxShift), and the supported ones read as people type them.
  const refused = await resolvePaneFunction(registry, context, parsePaneFunctionArgsFor(registry, ["WEI", "--fx-shift", "TRY"]), { strictHeadlessOptions: true })
    .catch((error: Error) => error.message);
  expect(refused).toBe("WEI does not support --fx-shift. It has no options.");
  await expect(fn(["MARS", "book", "--fx-shfit", "TRY"])).rejects.toThrow(
    "MARS does not support --fx-shfit. Supported options: --view, --since, --weights, --evidence, --equity-shift, --rate-shift, --vol-shift, --fx-shift, --asset-shift.",
  );
  await expect(resolvePaneFunction(registry, context, parsePaneFunctionArgsFor(registry, ["MARS", "--fx-shift", "USD", "10"]), { strictHeadlessOptions: true }))
    .rejects.toThrow("--fx-shift moves a currency against USD");
});

test("an option or argument a function refuses names the function code, never its template or pane id", async () => {
  const refused = await fn(["WEI", "--range", "1Y"], false).catch((error: Error) => error.message);
  expect(refused).toBe("WEI does not support --range. It has no options.");
  expect(refused).not.toContain("world-indices");
  const strict = await resolvePaneFunction(
    registry, context, { ...parsePaneFunctionArgs(["CALLS"]), requireBotSafe: true }, { strictHeadlessOptions: true },
  ).catch((error: Error) => error.message);
  expect(strict).toBe("CALLS requires exactly one ticker.");
});

test("a rendered view that takes only its declared options refuses any other, and opens on the tab asked for", async () => {
  // FUT's shape: --tab is read from pane state, which the workspace opens on, and from a setting that sizes a shot.
  const board: PaneDef = { ...pane("board"), reportOptionsOnly: true, reportOptions: [{ key: "tab", type: "enum", description: "Board",
    values: [{ value: "markets" }, { value: "inventories" }], settingKey: "workspaceTab", pluginState: { pluginId: "board-state", key: "board:tab" } }] };
  const catalog: PaneFunctionCatalog = {
    panes: new Map([["board", board]]),
    paneTemplates: new Map([["board-pane", { id: "board-pane", paneId: "board", label: "FUT", description: "FUT", shortcut: { prefix: "FUT", argPlaceholder: "" } }]]),
    destroy: () => {},
  };
  const open = (args: string[]) => resolvePaneFunction(catalog, context, parsePaneFunctionArgs(args));
  await expect(open(["FUT", "--bogus", "1"])).rejects.toThrow("FUT does not support --bogus. Supported options: --tab.");
  await expect(open(["FUT", "--tab", "curve"])).rejects.toThrow('Invalid --tab value "curve"');
  const inventories = await open(["FUT", "--tab", "inventories"]);
  expect(inventories.instance.settings).toEqual({ workspaceTab: "inventories" });
  expect(capabilityPluginState(inventories.capability, inventories.options)).toEqual({ "board-state": { "board:tab": "inventories" } });
});

test("a bar size under a minute points at GIP's 1-minute bars for the ticker asked about", async () => {
  const pointer = "No second or tick bars; 1-minute bars: fn GIP RMS.AX; trades exist for US listings only.";
  for (const value of ["1s", "30s", "tick", "500ms"]) {
    await expect(fn(["GIP", "RMS.AX", "--chartResolution", value])).rejects
      .toThrow(`Invalid --chart-resolution value "${value}". ${pointer} Use one of: auto, 1m, 5m, 15m, 1h.`);
  }
  await expect(fn(["GIP", "RMS.AX", "--resolution", "1s"])).rejects.toThrow(pointer);
  // Another interval it does not serve is only refused.
  await expect(fn(["GIP", "RMS.AX", "--chartResolution", "2m"])).rejects
    .toThrow('Invalid --chart-resolution value "2m". Use one of: auto, 1m, 5m, 15m, 1h.');
});

test("a name that opens nothing lists the closest functions and where to search, never an alphabetical list", async () => {
  const surface: PaneTemplateDef = {
    ...template("OVDV", "vol-surface", indices),
    label: "Volatility Surface",
    description: "Implied volatility surface and smiles.",
  };
  const withSurface: PaneFunctionCatalog = {
    ...registry,
    panes: new Map([...registry.panes, ["vol-surface", pane("vol-surface")]]),
    paneTemplates: new Map([...registry.paneTemplates, ["vol-surface-pane", surface]]),
  };
  const unknown = (name: string) => resolvePaneFunction(withSurface, context, parsePaneFunctionArgs([name, "SPY"]))
    .then(() => null, (error: unknown) => error as UnknownPaneFunctionError);

  const close = await unknown("volsurf");
  expect(close).toBeInstanceOf(UnknownPaneFunctionError);
  expect(close?.message).toBe('Unknown function or pane "volsurf".');
  expect(close?.details).toBe("Closest matches:\n  OVDV  Volatility Surface\nSearch the catalog: gloom catalog volsurf");
  // Near no code and found by no search: said plainly, with the whole catalog to look in.
  expect((await unknown("zzqxvb"))?.details).toBe("No function code is close to zzqxvb. List every function: gloom catalog");
});

test("a code one slip from a function's (swapped, missing or extra letter) names it and the command that runs it", async () => {
  const dcf: PaneTemplateDef = { ...template("RDCF", "reverse-dcf", indices), label: "Reverse DCF" };
  const withDcf: PaneFunctionCatalog = {
    ...registry,
    panes: new Map([...registry.panes, ["reverse-dcf", pane("reverse-dcf")]]),
    paneTemplates: new Map([...registry.paneTemplates, ["reverse-dcf-pane", dcf]]),
  };
  const unknown = (args: string[]) => resolvePaneFunction(withDcf, context, parsePaneFunctionArgs(args))
    .then(() => null, (error: unknown) => error as UnknownPaneFunctionError);
  for (const typed of ["RCDF", "rdc", "RDCFF"]) {
    const error = await unknown([typed, "PLTR"]);
    expect(error?.message).toBe(`Unknown function or pane "${typed}". Did you mean RDCF (Reverse DCF)?`);
    expect(error?.details).toBe("Run: gloom fn RDCF PLTR");
  }
  // Two letters off, or a name too short to tell, is no suggestion.
  expect((await unknown(["RDXX", "PLTR"]))?.message).toBe('Unknown function or pane "RDXX".');
  expect((await unknown(["WE", "PLTR"]))?.message).toBe('Unknown function or pane "WE".');
});

test("a bank figure typed as a function (NIM, one slip from NI) is pointed at the Bank section and EQS, not at NI", async () => {
  const news: PaneTemplateDef = { ...template("NI", "topic-news", indices), label: "Topic News" };
  const withNews: PaneFunctionCatalog = {
    ...registry,
    panes: new Map([...registry.panes, ["topic-news", pane("topic-news")]]),
    paneTemplates: new Map([...registry.paneTemplates, ["topic-news-pane", news]]),
  };
  for (const name of ["NIM", "deposits", "CRE"]) {
    const error = await resolvePaneFunction(withNews, context, parsePaneFunctionArgs([name, "jpm"])).then(() => null, (failure: unknown) => failure as UnknownPaneFunctionError);
    expect(error?.message, name).toBe(`${name} is not a function: a bank's figures are in the Bank section of fundamentals.`);
    expect(error?.details.split("\n"), name).toEqual([
      "Deposits, uninsured share, CRE / capital and the lead bank: gloom fundamentals JPM",
      "Net interest margin (Pro): gloom fn EQS --metric kpiNimPercent --definition "
        + `'{"version":1,"currency":null,"criteria":[{"field":"symbol","op":"in","value":["JPM"]}],"sort":{"field":"symbol","direction":"asc"}}'`,
    ]);
  }
  expect((await resolvePaneFunction(withNews, context, parsePaneFunctionArgs(["NIX", "JPM"])).catch((failure: Error) => failure))?.message)
    .toBe('Unknown function or pane "NIX". Did you mean NI (Topic News)?');
});

test("shot hands CDX, SOVR (or its alias WCDS) and IPO their argument as the params their pane opens on, never as a ticker", async () => {
  const templates = [...creditBoardsModule.paneTemplates ?? [], ...ipoCalendarPlugin.paneTemplates ?? []];
  const boards: PaneFunctionCatalog = {
    panes: new Map(["fixed-income", "ipo-calendar"].map((id) => [id, pane(id)])),
    paneTemplates: new Map(templates.map((entry) => [entry.id, entry])),
    destroy: () => {},
  };
  const shot = async (target: string, arg: string) => {
    const resolved = await resolvePaneFunction(boards, context, parsePaneFunctionArgs([target, arg]), { command: "shot" });
    return { params: resolved.instance.params, binding: resolved.instance.binding };
  };
  expect(await shot("CDX", "HY")).toEqual({ params: expect.objectContaining({ tab: "credit", view: "index", index: "HY" }), binding: { kind: "none" } });
  // WCDS is SOVR's alias, and the country keeps the spelling it was typed in.
  expect(await shot("WCDS", "Ivory Coast")).toEqual({ params: expect.objectContaining({ tab: "credit", view: "sovereign", country: "Ivory Coast" }), binding: { kind: "none" } });
  expect(await shot("IPO", "pending")).toEqual({ params: expect.objectContaining({ search: "pending" }), binding: { kind: "none" } });
});

/** `fn news-story-pane 2ef88dae-…` said "Not a ticker: 2EF88DAE-…": the story pane's argument is a story id, as `news` prints it. */
test("the story pane opens on the story id typed, whole or short, never read as a ticker", async () => {
  const stories: PaneFunctionCatalog = {
    panes: new Map((newsWireModule.panes ?? []).map((entry) => [entry.id, entry])),
    paneTemplates: new Map((newsWireModule.paneTemplates ?? []).map((entry) => [entry.id, entry])),
    destroy: () => {},
  };
  const open = async (id: string) => (await resolvePaneFunction(stories, context, parsePaneFunctionArgs(["news-story-pane", id]), { command: "shot" })).instance;
  const id = "6067684e-2e13-41c5-a7cf-5052b3cefc07";
  expect(await open(id)).toMatchObject({ params: { articleId: id }, binding: { kind: "none" } });
  // The short id `news` prints opens the story it starts.
  expect(shortStoryId(id)).toBe("6067684e");
  expect(await open("6067684e")).toMatchObject({ params: { articleId: "6067684e" }, binding: { kind: "none" } });
  expect(storyIdMatches(id, "6067684E")).toBe(true);
  expect(storyIdMatches(id, "6067684")).toBe(false);
  // An id from another source is printed and matched whole.
  expect(shortStoryId("rss:abc123")).toBe("rss:abc123");
  expect(storyIdMatches("rss:abc123", "rss:abc")).toBe(false);
});

test("an implied-vol word that is no code (IVOL, OVOL, IV) names HIVG and OVDV and runs each on the argument", async () => {
  const modules = [ivHistoryModule, volSurfaceModule];
  const vol: PaneFunctionCatalog = {
    panes: new Map(modules.flatMap((module) => module.panes ?? []).map((entry) => [entry.id, entry])),
    paneTemplates: new Map(modules.flatMap((module) => module.paneTemplates ?? []).map((entry) => [entry.id, entry])),
    destroy: () => {},
  };
  const unknown = (args: string[]) => resolvePaneFunction(vol, context, parsePaneFunctionArgs(args))
    .then(() => null, (error: unknown) => error as UnknownPaneFunctionError);
  for (const word of ["IVOL", "ovol", "IV"]) {
    const error = await unknown([word, "SPY"]);
    expect(error?.message).toBe(`Unknown function or pane "${word}". Did you mean HIVG (Implied Volatility History) or OVDV (Volatility Surface)?`);
    expect(error?.details.split("\n").slice(0, 2)).toEqual(["Run: gloom fn HIVG SPY", "     gloom fn OVDV SPY"]);
  }
  // With no argument, the one each takes.
  expect((await unknown(["IVOL"]))?.details).toBe("Run: gloom fn HIVG <ticker>\n     gloom fn OVDV <ticker>");
});

test("a central bank's name or short form typed as a function points to CBR, and a function that owns the word keeps it", async () => {
  const modules = [centralBankRatesModule, ratePathModule];
  const banks: PaneFunctionCatalog = {
    panes: new Map(modules.flatMap((module) => module.panes ?? []).map((entry) => [entry.id, entry])),
    paneTemplates: new Map(modules.flatMap((module) => module.paneTemplates ?? []).map((entry) => [entry.id, entry])),
    destroy: () => {},
  };
  const resolve = (args: string[]) => resolvePaneFunction(banks, context, parsePaneFunctionArgs(args));
  for (const word of ["ECB", "BOJ", "boe", "RBA", "BoC", "SNB", "Bank of Japan", "Federal Reserve"]) {
    const error = await resolve([word]).then(() => null, (failure: unknown) => failure as UnknownPaneFunctionError);
    expect(error?.message).toBe(`Unknown function or pane "${word}". Did you mean CBR (Central Bank Rates)?`);
    expect(error?.details.split("\n")[0]).toBe("Run: gloom fn CBR");
  }
  // FOMC is one of WIRP's own words, so it opens the rate path as before.
  expect((await resolve(["FOMC"])).token).toBe("WIRP");
});

test("a pane no template opens goes by its command-bar code, in the error that sends its reader to shot too", async () => {
  const layouts: PaneFunctionCatalog = { panes: new Map([["layout-marketplace", pane("layout-marketplace")]]), paneTemplates: new Map(), destroy: () => {} };
  for (const word of ["LAY", "layout-marketplace"]) {
    const resolved = await resolvePaneFunction(layouts, context, parsePaneFunctionArgs([word]));
    expect(resolved.token).toBe("LAY");
    await expect(buildFunctionReport(resolved, context, "")).rejects.toThrow("LAY is an interactive pane with no data report; run `gloom shot LAY` to see it.");
  }
});

test("CMP of one ticker says it needs two or more and how to ask, before any chart is built", async () => {
  const charts: PaneFunctionCatalog = {
    panes: new Map((chartComposerModule.panes ?? []).map((entry) => [entry.id, entry])),
    paneTemplates: new Map((chartComposerModule.paneTemplates ?? []).map((entry) => [entry.id, entry])),
    destroy: () => {},
  };
  const refusal = (command: "fn" | "shot", args: string[]) => resolvePaneFunction(charts, context, parsePaneFunctionArgs(args), { command })
    .then(() => null, (error: Error) => error.message);
  expect(await refusal("fn", ["CMP", "SPY"])).toBe("CMP needs two or more tickers: fn CMP SPY,QQQ");
  expect(await refusal("shot", ["CMP", "aapl"])).toBe("CMP needs two or more tickers: shot CMP AAPL,SPY");
  expect(await refusal("fn", ["CMP", "SPY,QQQ"])).toBeNull();
});

test("a list typed as words is a company search names, the tickers it holds, or a name nothing lists, which asks for tickers", async () => {
  const watch: HeadlessPaneDefinition<"bundle"> = { shape: "bundle", argument: { kind: "symbol-list" }, options: [], load: () => ({ sections: [] }) };
  const lists: PaneFunctionCatalog = { panes: new Map([["watch", pane("watch")]]), paneTemplates: new Map([["watch-pane", template("SIW", "watch", watch)]]), destroy: () => {} };
  const beyond = { providerId: "test", symbol: "BYND", name: "Beyond Meat, Inc.", exchange: "NASDAQ", currency: "USD", type: "Common Stock" };
  const market = {
    config: context.config,
    store: { loadTicker: async () => null, loadAllTickers: async () => [] },
    dataProvider: createTestDataProvider({
      search: async (query) => /beyond meat/i.test(query) ? [beyond] : [],
      // MEAT and BEYOND are tickers too: "Beyond Meat" read word by word was two other companies.
      getQuote: async (symbol) => {
        if (["GME", "AMC", "BYND", "BEYOND", "MEAT"].includes(symbol)) return createTestQuote({ symbol });
        throw new Error(`Not a ticker: ${symbol}.`);
      },
    }),
  } as unknown as MarketContext;
  const read = (arg: string) => applyListingArgument(lists, market, parsePaneFunctionArgs(["SIW", arg]));
  expect((await read("Beyond Meat")).arg).toBe("BYND:NASDAQ");
  expect((await read("GME AMC")).arg).toBe("GME, AMC");
  expect(await read("Foo Barbazqux").catch((error: Error & { details?: string }) => `${error.message}\n${error.details}`)).toBe(
    'No company found for "Foo Barbazqux"; type tickers.\nSuch as gloom fn SIW GME,AMC. Find a company\'s ticker with gloom search "Foo Barbazqux".',
  );
  // In a list, a name nothing lists is left out with the same answer, in any script.
  const partial = await read("任天堂 ソニー, Foo Barbazqux, AMC");
  expect(partial.arg).toBe("AMC");
  expect(partial.listingNotes).toContain('No company found for "任天堂 ソニー", "Foo Barbazqux"; type tickers, such as GME,AMC.');
});

test("every function the catalog lists with no argument refuses one, a rendered view (HALT) as a report (CBR) does", async () => {
  // Catalog discovery starts chat and instantiates the map's chart templates.
  spyOn(apiClient, "getChannels").mockResolvedValue([]);
  spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const catalog = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(catalog, context);
    const none = entries.filter((entry) => !entry.argPlaceholder && (!entry.argKind || entry.argKind === "none"));
    expect(none.map((entry) => entry.token)).toEqual(expect.arrayContaining(["CBR", "HALT", "HELP", "FI"]));
    for (const entry of none) {
      const refusal = await resolvePaneFunction(catalog, context, parsePaneFunctionArgs([entry.token, "DHI"]))
        .then(() => null, (error: Error) => error.message);
      expect(refusal, entry.token).toContain("does not accept an argument.");
    }
    expect(await resolvePaneFunction(catalog, context, parsePaneFunctionArgs(["HALT", "DHI"])).catch((error: Error) => error.message))
      .toBe("HALT does not accept an argument. Run: gloom fn HALT");
    // A rendered view that reads its argument with no shortcut declares it, so the catalog lists it and fn passes it on.
    const feed = entries.find((entry) => entry.templateId === "twitter-feed-pane");
    expect(feed?.argPlaceholder).toBe("query");
    const feedQuery = await resolvePaneFunction(catalog, context, parsePaneFunctionArgs(["twitter-feed-pane", "nvda"]));
    expect(feedQuery.instance.params?.query).toBe("nvda");
    // An X query may be a ticker, and is read as one: only an id the pane opens (the story pane's) is not.
    expect(feedQuery.instance.binding).toEqual({ kind: "fixed", symbol: "NVDA" });
    // A pane opened by its id stands for its templates, which take a ticker: it is not one of the catalog's functions.
    const byPaneId = await resolvePaneFunction(catalog, context, parsePaneFunctionArgs(["realized-vol", "DHI"]));
    expect(byPaneId.instance.binding).toEqual({ kind: "fixed", symbol: "DHI" });
  } finally {
    catalog.destroy();
    mock.restore();
  }
});

test("only a template that opens on a list takes one as symbols: shot DVD KO JNJ ranks both, while DES, ADR and EVTS keep their symbol and arg", async () => {
  const modules = [tickerDetailModule, earningsModule, dividendYieldModule];
  const catalog: PaneFunctionCatalog = {
    panes: new Map(modules.flatMap((module) => module.panes ?? []).map((entry) => [entry.id, entry])),
    paneTemplates: new Map(modules.flatMap((module) => module.paneTemplates ?? []).map((entry) => [entry.id, entry])),
    destroy: () => {},
  };
  for (const code of ["DES", "ADR", "EVTS"]) {
    const found = findPaneFunction(catalog, code)!;
    const before = buildCreateOptions(found.template, "KO, JNJ");
    expect(withTickerList(found.template, before, getHeadlessPaneDefinition(found.template, found.pane!), "KO, JNJ"), code).toBe(before);
    expect(before?.symbols, code).toBeUndefined();
  }
  // A report that takes a list does not make its one-ticker pane open on one.
  const listReport: HeadlessPaneDefinition<"bundle"> = { shape: "bundle", argument: { kind: "tickers" }, options: [], load: () => ({ sections: [] }) };
  const oneTicker = template("ONE", "one", listReport);
  const typed = buildCreateOptions(oneTicker, "KO, JNJ");
  expect(withTickerList(oneTicker, typed, listReport, "KO, JNJ")).toBe(typed);
  const dvd = await resolvePaneFunction(catalog, context, parsePaneFunctionArgs(["DVD", "KO, JNJ"]), { command: "shot" });
  expect(dvd.createOptions).toMatchObject({ symbol: "KO", arg: "KO,JNJ", symbols: ["KO", "JNJ"] });
  expect(dvd.instance.settings).toMatchObject({ rankSymbols: ["KO", "JNJ"] });
  // One ticker opens its own pane, and past fn's 25 the list is refused as fn refuses it.
  expect((await resolvePaneFunction(catalog, context, parsePaneFunctionArgs(["DVD", "KO"]), { command: "shot" })).createOptions?.symbols).toBeUndefined();
  const many = Array.from({ length: 26 }, (_, index) => `T${index}`).join(",");
  await expect(resolvePaneFunction(catalog, context, parsePaneFunctionArgs(["DVD", many]), { command: "shot" })).rejects.toThrow("DVD accepts at most 25 symbols.");
});
