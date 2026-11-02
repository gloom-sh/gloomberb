import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { getLoadablePlugins } from "../../plugins/catalog";
import { createDefaultConfig } from "../../types/config";
import type { MarketContext } from "../types";
import { buildPaneCatalogEntries, buildTemplateContext, filterPaneCatalogEntries, findFunctionCode, limitationSentence, renderPaneCatalogReport } from "./catalog";
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
    expect(codes("duration")).toEqual(expect.arrayContaining(["YAS", "ETF"]));
    expect(codes("steepener")).toContain("GC");
  } finally {
    registry.destroy();
    channels.mockRestore();
    geo.mockRestore();
  }
});
