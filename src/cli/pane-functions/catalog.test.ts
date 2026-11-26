import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { chatController } from "../../plugins/builtin/chat/controller";
import { subscribeASKGQuestions } from "../../plugins/builtin/cloud/askg/pending-question";
import { subscribeRequestedThesis } from "../../plugins/builtin/cloud/thesis/pane-request";
import { getLoadablePlugins } from "../../plugins/catalog";
import { createDefaultConfig } from "../../types/config";
import type { MarketContext } from "../types";
import type { PaneTemplateDef } from "../../types/plugin";
import {
  buildPaneCatalogEntries, buildTemplateContext, correctCatalogQuery, filterPaneCatalogEntries, findFunctionCode, functionsForQuestion, limitationSentence,
  paneFunctionCode, renderPaneCatalogReport, suggestedFunctionCodes, type PaneFunctionCatalog,
} from "./catalog";
import { GLOSSARY, lookupGlossary } from "../glossary";
import { buildPaneShortcutItems, buildPaneTemplateItem } from "../../components/command-bar/pane-templates/items";
import type { PluginRegistry } from "../../plugins/registry";
import { fuzzyFilter } from "../../utils/fuzzy-search";
import { createPaneCatalog } from "./discovery";
import { parsePaneCatalogArgs } from "./options";
import { parseViewSpec } from "../../plugins/builtin/custom-view/view-spec";
import { findPaneFunction } from "./resolver";

test("limitations read as sentences, so one does not run into the next", () => {
  const limitations = ["Daily medians of public DTCC prints on the on-the-run 5Y contract", "HY and EM quote in price"];
  expect(limitations.map(limitationSentence).join(" "))
    .toBe("Daily medians of public DTCC prints on the on-the-run 5Y contract. HY and EM quote in price.");
  // One that already ends a sentence keeps its own stop, inside a closing bracket or quote too.
  expect(["Covered.", "Is it covered?", "History starts 2024 (daily closes)", "Read \"as filed.\"", " Trailing space "].map(limitationSentence))
    .toEqual(["Covered.", "Is it covered?", "History starts 2024 (daily closes).", "Read \"as filed.\"", "Trailing space."]);
});

test("a function's code or alias is found in any case, with what it takes; a keyword or an ordinary word is not a code", () => {
  const template = (id: string, shortcut: Record<string, unknown>, keywords: string[] = []) => ({
    id, paneId: `${id}-pane`, label: id, description: "", keywords, shortcut,
  });
  const templates = [
    template("vol", { prefix: "OVDV", argKind: "ticker" }, ["volatility", "options"]),
    template("em", { prefix: "EM", aliases: ["EEO"], argKind: "ticker", argPlaceholder: "ticker" }),
    template("flow", { prefix: "FLOW" }, ["sweep"]),
    template("calendar", { prefix: "ERN", argKind: "ticker-list", argPlaceholder: "tickers" }),
  ];
  const registry = {
    panes: new Map(templates.map((entry) => [entry.paneId, { id: entry.paneId, name: entry.label }])),
    paneTemplates: new Map(templates.map((entry) => [entry.id, entry])),
    destroy() {},
  } as never;
  expect(findFunctionCode(registry, "OVDV")).toEqual({ argument: "<ticker>" });
  expect(findFunctionCode(registry, "ovdv")).toEqual({ argument: "<ticker>" });
  expect(findFunctionCode(registry, "eeo")).toEqual({ argument: "<ticker>" });
  expect(findFunctionCode(registry, "ern")).toEqual({ argument: "<tickers>" });
  expect(findFunctionCode(registry, "FLOW")).toEqual({ argument: "" });
  expect(findFunctionCode(registry, "volatility")).toBeNull();
  expect(findFunctionCode(registry, "OVDX")).toBeNull();
  expect(findFunctionCode(registry, "")).toBeNull();
});

test("built-in catalog discovery stays offline while opening chat and chokepoint panes still resolves live arguments", async () => {
  // Opening a chat pane fills the shared controller's channel list. Put it
  // back, so a Chat pane in a later test file is not moved to this channel.
  const chatChannels = (chatController as any).channelCatalog.channels;
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([
    { id: "startup-test-channel", name: "Startup test", created_at: "2026-01-01" },
  ]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Discovery must stay offline"));
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context, { unlisted: true });
    expect(channels).not.toHaveBeenCalled();
    expect(geo).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(entries.find((entry) => entry.token === "CHAT")?.defaultSettings).toEqual({});
    expect(entries.find((entry) => entry.token === "CHOKE")?.defaultSettings).toEqual({});

    const chat = registry.paneTemplates.get("new-chat-pane")!;
    const openedChat = await chat.createInstance!(buildTemplateContext(context, null), { arg: "startup-test-channel" });
    expect(openedChat?.settings?.channelId).toBe("startup-test-channel");
    expect(channels).toHaveBeenCalledTimes(1);

    const choke = registry.paneTemplates.get("chokepoint-chart-pane")!;
    const openedChart = await choke.createInstance!(buildTemplateContext(context, null), { arg: "suez" });
    expect(openedChart?.settings).toHaveProperty("chartSpec");
    expect(geo).toHaveBeenCalledTimes(1);
  } finally {
    (chatController as any).channelCatalog.channels = chatChannels;
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
    fetch.mockRestore();
  }
});

// A name that opens no function builds the catalog in the running app too, and discovery must not run ASKG and THESIS on a sample: an open Ask Gloom pane would be asked "sample", and with none open the next one to mount would open on it.
test("building the catalog sends no request to an open pane and leaves none for the next pane to open on", async () => {
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  const received: unknown[] = [];
  const subscribeAll = () => [
    subscribeASKGQuestions((question) => received.push(question)),
    subscribeRequestedThesis((request) => received.push(request)),
  ];
  let stops = subscribeAll();
  try {
    await buildPaneCatalogEntries(registry, context);
    expect(received).toEqual([]);
    // No pane open: a request would wait for the next one to subscribe.
    for (const stop of stops) stop();
    await buildPaneCatalogEntries(registry, context);
    stops = subscribeAll();
    expect(received).toEqual([]);
  } finally {
    for (const stop of stops) stop();
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});

// `catalog dax` found nothing, and signed out ASKG pointed at `gloom catalog <topic>` without running it.
test("the morning's European words lead to the index board, a question asked signed out to the functions its topic names, and VIEW to a spec that runs", async () => {
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const search = spyOn(apiClient, "searchInstrumentsBatch").mockImplementation(async (queries) => {
    const listings = [["IAG", "XLON"], ["LHA", "XETR"], ["AF", "XPAR"]];
    return new Map(queries.map((query) => [query, listings.filter(([symbol, exchange]) => `${symbol}:${exchange}` === query)
      .map(([symbol, exchange]) => ({ symbol: symbol!, exchange, name: symbol!, type: "Common Stock" }))]));
  });
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    const codes = (query: string) => filterPaneCatalogEntries(entries, query).map((entry) => entry.token);
    for (const query of ["dax", "xetra", "stoxx", "germany", "european indices"]) expect(codes(query), query).toContain("WEI");
    expect(codes("germany")).toContain("GC");
    expect(codes("dax")).toContain("CMP");
    // The question's asking words ("what", "did", "do") name nothing: "do" found DOE and DOCS.
    const found = await functionsForQuestion(registry, "what did the DAX do yesterday?");
    expect(found.map((entry) => entry.code).sort()).toEqual(["CMP", "WEI"]);
    expect(found.find((entry) => entry.code === "CMP")?.command).toBe("gloom fn CMP <tickers>");
    expect(await functionsForQuestion(registry, "what did it do?")).toEqual([]);
    expect((await functionsForQuestion(registry, "Latest US ISM and S&P Global, euro area, UK, Japan and China PMIs plus the Atlanta Fed GDPNow nowcast?"))
      .map(({ command, input }) => [command, input])).toEqual([
      ["gloom fn ECO US,EU,GB,JP,CN --impact all --search PMI", "ECO US,EU,GB,JP,CN"], ["gloom fn ECST gdpnow", "ECST gdpnow"],
    ]);
    // A rates question was offered CBR, then MDAY and FIRST: it gets CBR, GC and ECO, run for the markets it names.
    expect((await functionsForQuestion(registry, "What did the BoJ and RBA do with policy rates and how did JGB yields react?"))
      .map((entry) => [entry.command, entry.input ?? null])).toEqual([
      ["gloom fn CBR", null], ["gloom fn GC jgb", "GC JGB"], ["gloom fn ECO JP,AU", "ECO JP,AU"],
    ]);
    // Signed out, "What moved DAL UAL and AAL from November 9 to November 13, 2026?" was offered 13F, ALRT and HDS.
    const ask = async (question: string) => (await functionsForQuestion(registry, question)).map((entry) => [entry.command, entry.input ?? null]);
    expect(await ask("Compare IAG:LSE, LHA:XETRA and AF:EPA earnings and price moves")).toEqual([
      ["gloom fn CMP IAG:LSE,LHA:XETRA,AF:EPA", "CMP IAG:LSE,LHA:XETRA,AF:EPA"],
      ["gloom fn CN IAG:LSE", "CN IAG:LSE"], ["gloom fn ANR IAG:LSE", "ANR IAG:LSE"],
    ]);
    expect(await ask("What moved DAL UAL and AAL from November 9 to November 13, 2026?")).toEqual([
      ["gloom fn CMP DAL,UAL,AAL --from 2026-11-09 --to 2026-11-13", "CMP DAL,UAL,AAL"], ["gloom fn CN DAL", "CN DAL"], ["gloom fn ANR DAL", "ANR DAL"],
    ]);
    // Earnings, guidance and a sector's move keep their functions, run for the tickers named; "cut" is no policy rate's.
    expect(await ask("When does NVDA report earnings?")).toContainEqual(["gloom fn ERN NVDA", "ERN NVDA"]);
    expect((await ask("Which holdings report earnings this week?")).map(([command]) => command)).toContain("gloom fn ERN <tickers>");
    expect(await ask("Did UAL raise or cut its guidance?")).toEqual([["gloom fn GUIDE UAL", "GUIDE UAL"]]);
    expect((await ask("How did the airline sector do last week?"))[0]).toEqual(["gloom fn BI", null]);
    expect(await ask("Tell me about DAL")).toEqual([["gloom fn DES DAL", "DES DAL"], ["gloom fn CN DAL", "CN DAL"], ["gloom fn ANR DAL", "ANR DAL"]]);
    // A question no function answers gets none, not the closest noise (ECO, ATS and DOE; Time and Sales).
    expect(await ask("Why did airline stocks fall this week?")).toEqual([]);
    expect(await ask("Is now a good time to buy?")).toEqual([]);
    // A bank, an index or an indicator in capitals took the price functions as a ticker; RSI took the one-ticker functions from NVDA.
    expect(await ask("How has the RBNZ cash rate moved?")).toEqual([["gloom fn CBR", null], ["gloom fn GC --tab world", null], ["gloom fn ECO NZ", "ECO NZ"]]);
    expect(await ask("How did DXY do?")).toEqual([["gloom fn WEI", null]]);
    // The functions "rsi" names (alerts, backtests) run for NVDA, and none for RSI.
    const rsi = (await ask("What does the RSI of NVDA say?")).map(([command]) => command!);
    expect(rsi.some((command) => command.endsWith(" NVDA"))).toBe(true);
    expect(rsi.some((command) => /\bRSI\b/.test(command))).toBe(false);
    expect(await ask("What does the KST of NVDA say?")).toEqual([["gloom fn DES NVDA", "DES NVDA"], ["gloom fn CN NVDA", "CN NVDA"], ["gloom fn ANR NVDA", "ANR NVDA"]]);
    // "time" asks about nothing alone, but "time and sales" is the function's name.
    expect((await ask("time and sales"))[0]).toEqual(["gloom fn TAS <ticker>", null]);
    expect((await ask("Show me time & sales for AAPL"))[0]).toEqual(["gloom fn TAS AAPL", "TAS AAPL"]);
    // VIEW's example is a spec that runs as typed, not only `<spec JSON or empty>`.
    const [example] = entries.find((entry) => entry.token === "VIEW")?.argExamples ?? [];
    expect(parseViewSpec(example!.replace(/^'|'$/g, ""))?.source).toEqual({ kind: "inline", pane: "WEI" });
  } finally {
    search.mockRestore();
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});

test("a function's entry says Requires only for a sign-in or Pro, and names its other sources as Data", async () => {
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    const entry = (code: string) => renderPaneCatalogReport(entries, parsePaneCatalogArgs([code])).replace(/\x1b\[[0-9;]*m/g, "");
    // These run signed out: their Gloom Cloud data is where it comes from, not something to sign in for.
    for (const code of ["COT", "CBR", "BTMM", "HIVG"]) {
      expect(entry(code), code).not.toContain("Requires");
      expect(entry(code), code).toMatch(/\nData +\S/);
    }
    // A sign-in stays a requirement, beside the data it opens.
    expect(entry("BUZZ")).toContain("Requires     Free Gloom sign-in\nData         Gloom Cloud X mention history");
    // A number option says its range before a value is refused for it (`--days must be at least 30`).
    expect(entry("CDX")).toMatch(/--days <integer> +Days of a named index's daily levels\. From 30 to 1,100\. Default 365\./);
  } finally {
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});

// `catalog --all` listed functions with no code by their internal ids (twitter-feed-pane, team-pane).
test("a function with no code is listed by its name when the command line runs it, and left out when it has nothing to run", async () => {
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const uncoded = (await buildPaneCatalogEntries(registry, context)).filter((entry) => entry.templateId && !entry.shortcut);
    // Left out: New Portfolio Pane and New Watchlist Pane create what PF lists, Debug Log, Team and Unread are the app's.
    expect(uncoded.map((entry) => [entry.token, entry.templateId])).toEqual([
      ["gloom-trending", "attention-trending-pane"], ["story", "news-story-pane"], ["x-feed", "twitter-feed-pane"],
    ]);
    for (const { token, templateId } of uncoded) expect(findPaneFunction(registry, token)?.template?.id).toBe(templateId);
    // The id a script saved still opens it.
    expect(findPaneFunction(registry, "twitter-feed-pane")?.template?.id).toBe("twitter-feed-pane");
    // The UI audits still picture the panes left out for a user, under the template ids an older catalog listed them by.
    const audited = (await buildPaneCatalogEntries(registry, context, { appPanes: true })).map((entry) => entry.token);
    expect(audited).toEqual(expect.arrayContaining(["team-pane", "unread-inbox-pane", "new-portfolio-pane", "x-feed"]));
    // A name another function answers to first opens that one, so it is no code for this one: the id is, in errors and the catalog alike.
    const twin = { id: "story-twin", paneId: "news-story", label: "Story", description: "Another story pane" } as PaneTemplateDef;
    const withTwin: PaneFunctionCatalog = { ...registry, paneTemplates: new Map([...registry.paneTemplates, [twin.id, twin]]), destroy: () => {} };
    expect(paneFunctionCode(twin, registry.panes.get("news-story")!, withTwin)).toBe("story-twin");
    expect(paneFunctionCode(registry.paneTemplates.get("news-story-pane"), registry.panes.get("news-story")!, withTwin)).toBe("story");
    const listed = await buildPaneCatalogEntries(withTwin, context);
    expect(listed.filter((entry) => entry.paneId === "news-story").map((entry) => entry.token)).toEqual(["story", "story-twin"]);
  } finally {
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});

// `catalog managers` printed the ECO card as if ECO were the function for it, found through "purchasing managers' index".
test("a lone match found only through a word of its description is labelled the closest match; one named for the query is not", async () => {
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    const searched = (query: string) => renderPaneCatalogReport(filterPaneCatalogEntries(entries, query), parsePaneCatalogArgs([query]))
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(searched("managers")).toStartWith('Closest match for "managers": no function is named for it. Try gloom fn ECO <countries>.\n\nECO  Economic Calendar');
    // One that takes a ticker leads with it: EVT lists spin-offs, the IPO calendar none.
    expect(searched("spin-off")).toStartWith('Closest match for "spin-off": no function is named for it. Try gloom fn EVT <ticker>.\n\nEVT  Corporate Actions');
    expect(searched("vix")).toStartWith("VIX  VIX Curve");
  } finally {
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});

test("a perp venue's name finds PERP first, and a function only Pro opens is marked Pro where the catalog says its report is ready", async () => {
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    for (const query of ["binance", "OKX", "bybit", "hyperliquid", "binance futures"]) {
      expect(filterPaneCatalogEntries(entries, query)[0]?.token, query).toBe("PERP");
    }
    // A crypto carry trade starts from these words.
    for (const query of ["crypto", "bitcoin", "btc", "carry", "basis trade"]) expect(filterPaneCatalogEntries(entries, query).map((entry) => entry.token), query).toContain("PERP");
    // One letter off is read as the word it is near; a word no function is near, or one already found, is kept.
    expect(correctCatalogQuery(entries, "fundng")).toBe("funding");
    expect(correctCatalogQuery(entries, "fudning")).toBe("funding");
    expect(correctCatalogQuery(entries, "funding")).toBeNull();
    expect(correctCatalogQuery(entries, "xqzvw")).toBeNull();
    // A short word, or one a first letter apart, is another word rather than a typo.
    expect(correctCatalogQuery(entries, "moat")).toBeNull();
    expect(correctCatalogQuery(entries, "libor")).not.toBe("hibor");
    const plain = (args: string[]) => renderPaneCatalogReport(entries, parsePaneCatalogArgs(args)).replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain(["CALLS"])).toContain("Report       ready · Pro\n");
    for (const code of ["EM", "GUID"]) {
      expect(plain([code])).toContain("Report       ready · Sign-in\n");
      expect(plain([code])).toContain("Requires     Verified Gloom sign-in");
      expect(plain([code])).not.toContain("ready · Pro");
    }
    expect(plain(["earnings"])).toMatch(/\nCALLS +Earnings Calls +<ticker> +ready · Pro +Pro earnings/);
    // A free preview is no lock: PERP reads ready.
    expect(plain(["PERP"])).toContain("Report       ready\n");
  } finally {
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});

test("sizing a curve trade finds the bond calculator, a bond fund's DV01 and the Treasury futures under each word a trader searches", async () => {
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    const codes = (query: string) => filterPaneCatalogEntries(entries, query).map((entry) => entry.token);
    for (const query of ["dv01", "hedge ratio", "steepener"]) expect(codes(query), query).toEqual(expect.arrayContaining(["YAS", "ETF", "CTM"]));
    // A variance swap's strike is what VIX squares: VIX and the VIX futures curve, not CDS's or GC's swaps.
    expect(codes("variance swap").slice(0, 2)).toEqual(["VIX", "CTM"]);
    expect(codes("duration")).toEqual(expect.arrayContaining(["YAS", "ETF"]));
    expect(codes("steepener")).toContain("GC");
  } finally {
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});

// `catalog "when issued"` named PSD Crop Balances the closest match, for the "when" of "when a table is published".
test("the when-issued yield and the tail it measures find the auctions first, and the glossary's Tail beside When-issued", async () => {
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    for (const query of ["when issued", "when-issued", "WI", "tail", "auction tail"]) expect(filterPaneCatalogEntries(entries, query)[0]?.token, query).toBe("AUCT");
    expect(lookupGlossary("when issued").exact.map((entry) => entry.term)).toEqual(["When-issued", "Tail"]);
    expect(lookupGlossary("WI").exact.map((entry) => entry.term)).toEqual(["When-issued", "Tail"]);
  } finally {
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});

test("reading put skew finds the surface's skew tab first, ahead of the screen that ranks it", async () => {
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    for (const query of ["put skew", "25d put", "risk reversal"]) expect(filterPaneCatalogEntries(entries, query)[0]?.token, query).toBe("OVDV");
  } finally {
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});

test("a memo's figures find FA with the tab that shows them, and an option's value finds its function with the command", async () => {
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    const searched = (query: string) => renderPaneCatalogReport(filterPaneCatalogEntries(entries, query), parsePaneCatalogArgs([query]))
      .replace(/\x1b\[[0-9;]*m/g, "");
    for (const query of ["roic", "return on invested capital", "operating margin", "capex", "free cash flow"]) {
      expect(filterPaneCatalogEntries(entries, query).slice(0, 3).map((entry) => entry.token), query).toContain("FA");
    }
    expect(searched("roic")).toStartWith('"roic": gloom fn FA <ticker> --statement profitability\n\nFA  Financial Analysis');
    expect(searched("capex")).toStartWith('"capex": gloom fn FA <ticker> --statement cashflow');
    // GF still answers a margin across companies, by the metric its option takes.
    expect(searched("operating margin").replace(/\s+/g, " ")).toContain("gloom fn GF <tickers> --metric operatingMargin");
    // An EQS preset is found by its value, which only the option's list named.
    expect(searched("compounders")).toStartWith('"compounders": gloom fn EQS --preset compounders\n\nEQS  Equity Screener');
  } finally {
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});

// `fn VAR my` offered VAL, `catalog VAR` left MARS and PORT out and the command bar found nothing for "value at risk":
// the glossary knew VaR was PORT's, and nothing looked there.
test("a risk term a function shows reaches it from catalog, fn's hint and the command bar, as the glossary names it", async () => {
  const channels = spyOn(apiClient, "getChannels").mockResolvedValue([]);
  const geo = spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
  const context = { config: createDefaultConfig("/synthetic/catalog-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    // Every function a glossary term names is one the catalog lists, so a term never points nowhere.
    const tokens = new Set(entries.flatMap((entry) => [entry.token, ...entry.aliases]));
    for (const entry of GLOSSARY) for (const code of entry.functions) expect(tokens.has(code), `${entry.term}: ${code}`).toBe(true);
    const leading = (query: string) => filterPaneCatalogEntries(entries, query).slice(0, 2).map((entry) => entry.token).sort();
    for (const query of ["VAR", "value at risk", "expected shortfall", "cvar", "stress test"]) expect(leading(query), query).toEqual(["MARS", "PORT"]);
    expect(filterPaneCatalogEntries(entries, "drawdown").map((entry) => entry.token)).toEqual(expect.arrayContaining(["MARS", "PORT"]));
    expect(suggestedFunctionCodes(registry, "VAR").map((entry) => entry.code)).toEqual(["MARS", "PORT"]);
    expect(suggestedFunctionCodes(registry, "drawdown").map((entry) => entry.code)).toEqual(["MARS", "PORT"]);
    // The command bar finds them for the same words, as one of the rows it ranks.
    const templates = [...registry.paneTemplates.values()].filter((template) => template.shortcut?.prefix);
    const pluginRegistry = { getPaneTemplatePluginId: () => null, allPlugins: new Map(), panes: registry.panes } as unknown as PluginRegistry;
    const found = (query: string) => fuzzyFilter(buildPaneShortcutItems({
      templates, searchedQuery: query, registry: pluginRegistry,
      createItem: (template, options) => buildPaneTemplateItem({
        template, pluginRegistry, ...options, runPaneTemplateShortcut: () => {}, shouldOpenTemplateConfig: () => false,
        openPaneTemplateWorkflow: () => {}, openPaneTemplateDirect: () => {},
      }),
    }), query, (row) => `${row.label} ${row.searchText ?? ""} ${row.detail} ${row.right ?? ""}`, (row) => row.label).map((row) => row.right);
    for (const query of ["var", "value at risk", "expected shortfall", "stress test"]) expect(found(query).slice(0, 2).sort(), query).toEqual(["MARS", "PORT"]);
    // HP and RETURN show a drawdown too.
    expect(found("drawdown")).toEqual(expect.arrayContaining(["MARS", "PORT"]));

    // A word of a common search, or a loose alias of a term (basis points, implied fx, close), names no function: these
    // list what they listed before the glossary counted.
    for (const query of ["fx", "earnings", "basis", "chart", "close", "exposure", "basis points", "implied fx", "beta", "trade"]) {
      expect(filterPaneCatalogEntries(entries, query).map((entry) => entry.token), query)
        .toEqual(filterPaneCatalogEntries(entries, query, { glossary: false }).map((entry) => entry.token));
    }
    // Nor do they send fn's hint to a function: only a term, its abbreviation or a name for its subject does.
    for (const query of ["fx", "earnings", "basis", "chart", "close", "exposure", "basis points"]) {
      expect(suggestedFunctionCodes(registry, query).filter((entry) => ["MARS", "PORT", "QQ", "GC"].includes(entry.code)), query).toEqual([]);
    }
  } finally {
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});
