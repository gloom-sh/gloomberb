import { afterAll, expect, test } from "bun:test";
import { createPaneDiscoveryContext } from "../../../cli/pane-functions/discovery";
import { parseDocsFeed } from "../../../docs/content";
import { DOCS_SNAPSHOT } from "../../../docs/snapshot.chunk";
import { docsTopicExists, docsTopicKey } from "../../../docs/topics";
import { createDefaultConfig } from "../../../types/config";
import type { CommandDef, GloomPlugin, GloomPluginContext, PaneDef, PaneTemplateDef } from "../../../types/plugin";
import { uiBuiltinPlugins } from "../../catalog-ui";
import { buildHelpFunctionIndex, listHelpFunctions } from "../help/function-index";
import { docsTopicForArgument, docsTopicForFunction, docsTopicForPane } from "./targets";

/**
 * The `?` on a pane must never open nothing. Every built-in pane and every
 * built-in function resolves to an entry in the docs the app ships, and the
 * ones that do not are listed here, so a new pane without docs fails instead
 * of quietly opening an empty reader. Add its entry on gloom.sh
 * (client/lib/functions.ts or a docs page), then `bun run docs:snapshot`.
 */

const started: GloomPlugin[] = [];
afterAll(() => {
  for (const plugin of started.splice(0).reverse()) plugin.dispose?.();
});

async function builtIns() {
  const config = createDefaultConfig("/tmp/docs-targets-test");
  const { panes, paneTemplates, ...context } = createPaneDiscoveryContext({ getConfig: () => config });
  const pluginCommands: CommandDef[] = [];
  const setupContext: GloomPluginContext = {
    ...context,
    registerCommand: (command) => { pluginCommands.push(command); },
  };
  for (const plugin of uiBuiltinPlugins) {
    for (const pane of plugin.panes ?? []) panes.set(pane.id, pane);
    for (const template of plugin.paneTemplates ?? []) paneTemplates.set(template.id, template);
    started.push(plugin);
    await plugin.setup?.(setupContext);
  }
  const templates: PaneTemplateDef[] = [...paneTemplates.values()];
  const index = buildHelpFunctionIndex({ pluginCommands, paneTemplates: templates });
  const registry = { panes, paneTemplates, getPanePluginId: () => null, getPaneTemplatePluginId: () => null, allPlugins: new Map() };
  return { panes: [...panes.values()] as PaneDef[], index, registry };
}

const shipped = parseDocsFeed(DOCS_SNAPSHOT)!;

test("every built-in pane and function opens an entry in the docs the app ships", async () => {
  const { panes, index, registry } = await builtIns();
  const uncovered: string[] = [];
  for (const pane of panes) {
    const topic = docsTopicForPane(index, registry as never, { paneId: pane.id });
    if (!topic || !docsTopicExists(shipped, topic)) uncovered.push(`pane ${pane.id} -> ${topic ? docsTopicKey(topic) : "nothing"}`);
  }
  for (const fn of listHelpFunctions(index)) {
    const topic = docsTopicForFunction(fn);
    if (!docsTopicExists(shipped, topic)) uncovered.push(`function ${fn.code} -> ${docsTopicKey(topic)}`);
  }
  expect(panes.length).toBeGreaterThan(100);
  expect(uncovered).toEqual([]);
});

test("DOCS takes a mnemonic or an alias, with its argument or without, and searches anything else", async () => {
  const { index } = await builtIns();
  expect(docsTopicForArgument(index, "omon nvda")).toEqual({ kind: "function", code: "OMON" });
  expect(docsTopicForArgument(index, "BTST")).toEqual({ kind: "function", code: "BT" });
  expect(docsTopicForArgument(index, "MCP")).toEqual({ kind: "page", slug: "mcp" });
  expect(docsTopicForArgument(index, "options chain")).toEqual({ kind: "home", query: "options chain" });
  expect(docsTopicForArgument(index, "  ")).toEqual({ kind: "home" });
});
