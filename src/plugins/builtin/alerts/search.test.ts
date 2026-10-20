import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildPaneShortcutItems, buildPaneTemplateItem } from "../../../components/command-bar/pane-templates/items";
import type { PaneTemplateDef } from "../../../types/plugin";
import type { PluginRegistry } from "../../registry";
import { alertsPlugin } from "./index";

// ALRT covers far more than prices; a user typing the kind of alert they want
// has to land on it. The bar ranks a pane row on its label, keywords and
// description together, so the row is built the way the bar builds it.
let template: PaneTemplateDef;

beforeAll(async () => {
  const ctx = {
    registerCommand() {},
    registerPane() {},
    registerPaneTemplate(registered: PaneTemplateDef) { template = registered; },
    configState: { get: () => null, set() {} },
    marketData: { getQuote: async () => { throw new Error("no quote expected"); } },
    paneSettings: { get: () => "15" },
    notify() {},
    showPane() {},
    log: { info() {}, warn() {} },
  };
  await alertsPlugin.setup?.(ctx as never);
});

afterAll(() => alertsPlugin.dispose?.());

function search(query: string): string[] {
  const pluginRegistry = {
    getPaneTemplatePluginId: () => "alerts",
    allPlugins: new Map([["alerts", alertsPlugin]]),
  } as unknown as PluginRegistry;
  return buildPaneShortcutItems({
    templates: [template],
    filterQuery: query,
    createItem: (candidate, options) => buildPaneTemplateItem({
      template: candidate,
      pluginRegistry,
      category: options?.category,
      showShortcut: options?.showShortcut,
      runPaneTemplateShortcut: () => {},
      shouldOpenTemplateConfig: () => false,
      openPaneTemplateWorkflow: () => {},
      openPaneTemplateDirect: () => {},
    }),
  }).map((item) => item.right ?? item.id);
}

describe("ALRT in the command bar", () => {
  test.each([
    "alerts",
    "price alert",
    "filing alert",
    "news alert",
    "earnings alert",
    "cpi",
    "fomc",
    "13f alert",
    "insider",
    "congress",
    "options flow",
    "unusual volume",
    "short interest",
    "perps",
  ])("%s finds the Alerts pane", (query) => {
    expect(search(query)).toEqual(["ALRT"]);
  });

  test("a query about something else does not", () => {
    expect(search("nvidia")).toEqual([]);
  });
});
