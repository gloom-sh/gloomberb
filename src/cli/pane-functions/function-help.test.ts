import { afterAll, expect, test } from "bun:test";
import { buildHelpFunctionIndex, listHelpFunctions } from "../../plugins/builtin/help/function-index";
import { uiBuiltinPlugins } from "../../plugins/catalog-ui";
import { createDefaultConfig } from "../../types/config";
import type { CommandDef, GloomPlugin, GloomPluginContext, PaneTemplateDef } from "../../types/plugin";
import { createPaneDiscoveryContext } from "./discovery";
import { FUNCTION_HELP } from "./function-help";

const started: GloomPlugin[] = [];
afterAll(() => {
  for (const plugin of started.splice(0).reverse()) plugin.dispose?.();
});

/** Every mnemonic the app's own plugins and commands register, as the command bar sees them. */
async function builtInFunctionCodes(): Promise<string[]> {
  const config = createDefaultConfig("/tmp/function-help-test");
  const { panes, paneTemplates, ...context } = createPaneDiscoveryContext({ getConfig: () => config });
  const pluginCommands: CommandDef[] = [];
  const setupContext: GloomPluginContext = {
    ...context,
    registerCommand: (command) => { pluginCommands.push(command); },
  };
  for (const plugin of uiBuiltinPlugins) {
    for (const pane of plugin.panes ?? []) panes.set(pane.id, pane);
    for (const template of plugin.paneTemplates ?? []) paneTemplates.set(template.id, template);
    pluginCommands.push(...(plugin.commands ?? []));
    started.push(plugin);
    await plugin.setup?.(setupContext);
  }
  const templates: PaneTemplateDef[] = [...paneTemplates.values()];
  return listHelpFunctions(buildHelpFunctionIndex({ pluginCommands, paneTemplates: templates })).map((fn) => fn.code);
}

test("every built-in function has a help card, and every card a function", async () => {
  const codes = await builtInFunctionCodes();
  expect(codes.length).toBeGreaterThan(100);
  expect(codes.filter((code) => !FUNCTION_HELP[code]).sort()).toEqual([]);
  expect(Object.keys(FUNCTION_HELP).filter((code) => !codes.includes(code)).sort()).toEqual([]);
});

// The Plugins pane and gloom.sh count a plugin's Pro functions from `access`,
// so a card whose freshness says Pro only has to be tagged as one.
test("a function is tagged Pro exactly when Free gets nothing but the upgrade", () => {
  const proOnly = Object.entries(FUNCTION_HELP).filter(([, help]) => help.data?.free === "Pro only").map(([code]) => code);
  const tagged = Object.entries(FUNCTION_HELP).filter(([, help]) => help.access === "pro").map(([code]) => code);
  expect(tagged.sort()).toEqual(proOnly.sort());
});
