import { afterEach, expect, test } from "bun:test";
import { buildPaneCatalogEntries, nearFunctionCodes } from "../../../cli/pane-functions/catalog";
import { createPaneCatalog } from "../../../cli/pane-functions/discovery";
import { findPaneFunction } from "../../../cli/pane-functions/resolver";
import type { MarketContext } from "../../../cli/types";
import { buildAssistCommandInventory } from "../../../components/command-bar/assist/inventory";
import { buildNonShortcutPaneTemplateItems, buildPaneShortcutItems, getAvailablePaneShortcutTemplatesForQuery } from "../../../components/command-bar/pane-templates/items";
import { createDefaultConfig } from "../../../types/config";
import type { PaneTemplateDef } from "../../../types/plugin";
import { buildBuiltinManifest } from "../../catalog-manifest";
import { getLoadablePlugins } from "../../catalog";
import type { PluginRegistry } from "../../registry";
import { chatFunctionsFrom } from "../chat/pane-links/commands";
import { filterCommandSuggestions } from "../chat/content/command-suggestions";
import { buildASKGToolManifests } from "../cloud/askg/manifest";
import { listViewSources } from "../custom-view/sources";
import { pickerFields } from "../equity-screener/model";
import { buildHelpFunctionIndex, parseHelpArgument } from "../help/function-index";
import { resolveWindowTemplates } from "../help/shortcut-model";
import { attentionModule } from "./index";
import { ATTENTION_LISTED } from "./listing";

/**
 * ATTN stays unlisted until research attention publishes: no list or search
 * of functions offers it, while typing its code still opens it.
 */

const context = { config: createDefaultConfig("/tmp/attention-listing-test") } as MarketContext;
const catalogs: Array<{ destroy(): void }> = [];
afterEach(() => {
  for (const catalog of catalogs.splice(0)) catalog.destroy();
});

async function builtInCatalog() {
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  catalogs.push(registry);
  return registry;
}

const attn = attentionModule.paneTemplates!.find((template) => template.id === "attention-pane")!;
const trending = attentionModule.paneTemplates!.find((template) => template.id === "attention-trending-pane")!;

test("ATTN ships unlisted", () => {
  expect(ATTENTION_LISTED).toBe(false);
  expect(attn.listed).toBe(false);
  expect(attn.shortcut?.prefix).toBe("ATTN");
  // Gloom Trending sits on Home and stays findable.
  expect(trending.listed).toBeUndefined();
});

test("the command bar lists no ATTN row but still opens ATTN when it is typed", () => {
  const registry = {
    paneTemplates: new Map([[attn.id, attn], [trending.id, trending]]),
    getPaneTemplatePluginId: () => null,
  } as unknown as PluginRegistry;
  const barContext = { config: {} as never, layout: { instances: [] } as never, focusedPaneId: null, activeTicker: null, activeCollectionId: null };
  const createItem = (template: PaneTemplateDef) => ({ id: template.id }) as never;

  expect(buildPaneShortcutItems({ templates: [attn, trending], createItem })).toEqual([]);
  expect(buildNonShortcutPaneTemplateItems({ templates: [attn, trending], createItem }).map((item) => item.id)).toEqual([trending.id]);
  for (const query of ["ATTN", "attn", "ATTN 6758:JPX"]) {
    expect(getAvailablePaneShortcutTemplatesForQuery({ pluginRegistry: registry, disabledPlugins: [], context: barContext, query }).map((template) => template.id), query)
      .toEqual([attn.id]);
  }
});

test("Help, the assistant's command list and chat suggestions leave ATTN out", () => {
  const index = buildHelpFunctionIndex({ pluginCommands: [], paneTemplates: [attn, trending] });
  // HELP ATTN still answers; HELP <words> does not find it.
  expect(parseHelpArgument("ATTN", index)).toMatchObject({ kind: "function", fn: { code: "ATTN" } });
  expect(parseHelpArgument("research attention", index)).toEqual({ kind: "search", query: "research attention", matches: [] });

  const registry = { paneTemplates: new Map([[attn.id, attn]]), getPaneTemplatePluginId: () => null, allPlugins: new Map() };
  expect(resolveWindowTemplates(registry as never)).toEqual([]);

  expect(buildAssistCommandInventory({ commands: [], pluginCommands: [], paneTemplates: [attn] })).toEqual([]);

  const functions = chatFunctionsFrom({ paneTemplates: new Map([[attn.id, attn]]), commands: new Map() }, []);
  // A typed ATTN still draws its chip; it is only never suggested.
  expect(functions.get("ATTN")).toMatchObject({ code: "ATTN", unlisted: true });
  expect(filterCommandSuggestions(functions, "ATT")).toEqual([]);
  expect(filterCommandSuggestions(functions, "research")).toEqual([]);
});

test("gloom catalog, search and suggestions leave ATTN out, and fn ATTN still runs and is helped", async () => {
  const registry = await builtInCatalog();
  const listed = await buildPaneCatalogEntries(registry, context);
  expect(listed.length).toBeGreaterThan(100);
  expect(listed.filter((entry) => entry.templateId === attn.id || entry.paneId === "attention")).toEqual([]);
  expect(listed.some((entry) => entry.templateId === trending.id)).toBe(true);

  const all = await buildPaneCatalogEntries(registry, context, { unlisted: true });
  expect(all.find((entry) => entry.templateId === attn.id)?.token).toBe("ATTN");

  expect(findPaneFunction(registry, "ATTN")?.template?.id).toBe(attn.id);
  expect(nearFunctionCodes(registry, "ATTM").map(({ code }) => code)).not.toContain("ATTN");
});

test("the assistant's tools, view sources and the published plugin catalog leave ATTN out", async () => {
  const registry = await builtInCatalog();
  const tools = buildASKGToolManifests(registry).tools.map((tool) => tool.name);
  expect(tools).toContain("eqs");
  expect(tools.filter((name) => name === "attn" || name === "attention")).toEqual([]);

  const sources = listViewSources(registry).map((source) => source.token);
  expect(sources).toContain("EQS");
  expect(sources.filter((token) => token === "ATTN" || token === "attention")).toEqual([]);

  const altData = buildBuiltinManifest().plugins.find((plugin) => plugin.id === "alt-data")!;
  expect(altData.contributes.shortcuts?.map((shortcut) => shortcut.code)).not.toContain("ATTN");
  expect(altData.description).not.toContain("research attention");
});

test("the EQS pickers offer ATTN's fields only to a screen that already uses one", () => {
  const fields = [{ id: "marketCap" }, { id: "attentionResearchUnits" }, { id: "attentionZScore" }, { id: "appAttentionScore" }];
  expect(pickerFields(fields).map((field) => field.id)).toEqual(["marketCap", "appAttentionScore"]);
  expect(pickerFields(fields, ["attentionZScore"]).map((field) => field.id)).toEqual(["marketCap", "attentionZScore", "appAttentionScore"]);
  // Listed again, every field is offered.
  expect(pickerFields(fields, [], true)).toEqual(fields);
});
