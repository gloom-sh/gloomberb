import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { chatController } from "../../plugins/builtin/chat/controller";
import { getLoadablePlugins } from "../../plugins/catalog";
import { createDefaultConfig } from "../../types/config";
import type { MarketContext } from "../types";
import { buildPaneCatalogEntries, buildTemplateContext, correctCatalogQuery, filterPaneCatalogEntries, findFunctionCode, limitationSentence, renderPaneCatalogReport } from "./catalog";
import { createPaneCatalog } from "./discovery";
import { parsePaneCatalogArgs } from "./options";

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
    expect(entry("COT")).toContain("Data         Gloom Cloud CFTC history");
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
    expect(searched("managers")).toStartWith('Closest match for "managers": no function is named for it.\n\nECO  Economic Calendar');
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
