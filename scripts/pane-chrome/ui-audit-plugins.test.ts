import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../src/types/config";
import type { GloomPlugin, PaneDef, PaneTemplateDef } from "../../src/types/plugin";
import { discoverAuditPluginEntries } from "./ui-audit-plugins";

const config = createDefaultConfig("/synthetic/ui-audit-discovery");
const pane = (id: string): PaneDef => ({ id, name: id, component: () => null, defaultPosition: "right" });
const template = (id: string, paneId: string, token: string): PaneTemplateDef => ({
  id, paneId, label: id, description: id, shortcut: { prefix: token }, createInstance: () => ({}),
});

test("audit discovers async setup panes and keeps one template-first entry per pane", async () => {
  let disposed = false;
  const plugin: GloomPlugin = {
    id: "dynamic-plugin", name: "Dynamic plugin", version: "1",
    panes: [pane("shared"), pane("untemplated")],
    paneTemplates: [template("shared-template", "shared", "OLD")],
    async setup(ctx) {
      await Promise.resolve();
      ctx.registerPane(pane("shared"));
      ctx.registerPaneTemplate(template("shared-template", "shared", "SHARED"));
      ctx.registerPaneTemplate(template("shared-report", "shared", "REPORT"));
      ctx.registerPane(pane("dynamic"));
      ctx.registerPaneTemplate({ ...template("dynamic-template", "dynamic", "DYNAMIC"), shortcut: { prefix: "DYNAMIC", argKind: "text" } });
    },
    dispose() { disposed = true; },
  };
  expect(await discoverAuditPluginEntries(plugin, config)).toEqual([
    { token: "SHARED", paneId: "shared", argKind: null, plugin: plugin.id },
    { token: "DYNAMIC", paneId: "dynamic", argKind: "text", plugin: plugin.id },
    { token: "untemplated", paneId: "untemplated", plugin: plugin.id },
  ]);
  expect(disposed).toBe(true);
});

test("failed audit discovery cleans up and preserves setup errors over disposal errors", async () => {
  const failure = new Error("setup failed");
  let disposed = 0;
  const plugin: GloomPlugin = {
    id: "failing-plugin", name: "Failing plugin", version: "1",
    async setup(ctx) {
      ctx.registerPane(pane("partial"));
      await Promise.resolve();
      throw failure;
    },
    dispose() { disposed += 1; throw new Error("dispose failed"); },
  };
  await expect(discoverAuditPluginEntries(plugin, config)).rejects.toBe(failure);
  expect(disposed).toBe(1);
  await expect(discoverAuditPluginEntries({ ...plugin, setup() {} }, config)).rejects.toThrow("dispose failed");
});
