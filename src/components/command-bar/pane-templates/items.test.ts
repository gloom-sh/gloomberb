import { expect, test } from "bun:test";
import type { PluginRegistry } from "../../../plugins/registry";
import type { PaneTemplateDef } from "../../../types/plugin";
import { buildPaneShortcutItems, getAvailablePaneShortcutTemplatesForQuery, recentPaneTemplateArg } from "./items";

const template = (shortcut: PaneTemplateDef["shortcut"]) => ({ id: "t", paneId: "p", label: "T", shortcut }) as PaneTemplateDef;

// Recent pane runs are saved to config.json, exported with it and synced, so
// only ticker arguments may be kept.
test("a recent pane run keeps a ticker argument and drops free text", () => {
  expect(recentPaneTemplateArg(template({ prefix: "GP", argPlaceholder: "ticker" }), " nvda ")).toBe("NVDA");
  expect(recentPaneTemplateArg(template({ prefix: "COMP", argKind: "ticker-list" }), "aapl msft")).toBe("AAPL MSFT");
  expect(recentPaneTemplateArg(template({ prefix: "ASKG", argKind: "text" }), "how exposed am I to rates")).toBeUndefined();
  expect(recentPaneTemplateArg(template({ prefix: "EXPO", argKind: "text" }), "AAPL=60% NVDA=40%")).toBeUndefined();
  expect(recentPaneTemplateArg(template({ prefix: "PORT", argKind: "text", argPlaceholder: "portfolio-id" }), "main")).toBeUndefined();
  expect(recentPaneTemplateArg(template(undefined), "anything")).toBeUndefined();
});

test("a hidden shortcut stays executable but has no browse row", () => {
  const hidden = { ...template({ prefix: "OLD", showInBrowse: false }), id: "legacy-view" };
  const registry = {
    paneTemplates: new Map([[hidden.id, hidden]]),
    getPaneTemplatePluginId: () => null,
  } as unknown as PluginRegistry;
  const context = {
    config: {} as never,
    layout: { instances: [] } as never,
    focusedPaneId: null,
    activeTicker: null,
    activeCollectionId: null,
  };

  expect(buildPaneShortcutItems({
    templates: [hidden],
    createItem: (candidate) => ({ id: candidate.id }) as never,
  })).toEqual([]);
  expect(getAvailablePaneShortcutTemplatesForQuery({
    pluginRegistry: registry,
    disabledPlugins: [],
    context,
    query: "OLD",
  })).toEqual([hidden]);
});

test("a phrase spelling out a longer code is searched, not read as a ticker argument", () => {
  const ticker = (id: string, prefix: string) => ({ id, paneId: id, label: prefix, shortcut: { prefix, argKind: "ticker" } }) as PaneTemplateDef;
  const etf = ticker("sec-etf-pane", "ETF");
  const jobs = ticker("jobs-pane", "JOBS");
  const flows = { id: "crypto-etf-flows-pane", paneId: "crypto-etf-flows", label: "Crypto ETF Flows", keywords: ["etf flows"], shortcut: { prefix: "ETFF" } } as PaneTemplateDef;
  const macroDay = { id: "macro-day-pane", paneId: "macro-day", label: "Macro-Day", keywords: ["jobs day"], shortcut: { prefix: "MDAY" } } as PaneTemplateDef;
  const registry = {
    paneTemplates: new Map([etf, jobs, flows, macroDay].map((entry) => [entry.id, entry])),
    getPaneTemplatePluginId: () => null,
  } as unknown as PluginRegistry;
  const context = { config: {} as never, layout: { instances: [] } as never, focusedPaneId: null, activeTicker: null } as never;
  const matching = (query: string) => getAvailablePaneShortcutTemplatesForQuery({ pluginRegistry: registry, disabledPlugins: [], context, query })
    .map((entry) => entry.id);
  expect(matching("ETF flows")).toEqual([]);
  expect(matching("ETF IBIT")).toEqual(["sec-etf-pane"]);
  // MDAY does not extend JOBS, so this stays Jobs for Dayforce.
  expect(matching("JOBS DAY")).toEqual(["jobs-pane"]);
});
