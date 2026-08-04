import { describe, expect, test } from "bun:test";
import type { CommandDef, PaneTemplateDef } from "../../../types/plugin";
import type { Command } from "../commands/registry";
import { buildAssistCommandInventory } from "./inventory";

function command(overrides: Partial<Command> & { prefix: string }): Command {
  return {
    id: overrides.prefix.toLowerCase(),
    label: "Command",
    description: "A command",
    category: "Config",
    ...overrides,
  };
}

function paneTemplate(overrides: Partial<PaneTemplateDef> & { id: string }): PaneTemplateDef {
  return {
    paneId: "pane",
    label: "Template",
    description: "A template",
    ...overrides,
  };
}

describe("buildAssistCommandInventory", () => {
  test("maps arg placeholders onto the kinds the shortcut parser uses", () => {
    const inventory = buildAssistCommandInventory({
      commands: [
        command({ prefix: "DES", aliases: ["T"], label: "Description", hasArg: true, argPlaceholder: "ticker" }),
        command({ prefix: "HELP", label: "Help", description: "Open the help window" }),
        command({ prefix: "LAY", label: "Layout Actions", hasArg: true, argPlaceholder: "action" }),
      ],
      pluginCommands: [{
        id: "direct-message",
        label: "DM",
        description: "Open a DM",
        keywords: [],
        category: "navigation",
        shortcut: "dm",
        shortcutArg: { placeholder: "@username" },
        execute: () => {},
      }],
      paneTemplates: [
        paneTemplate({
          id: "research",
          label: "New Research Pane",
          description: "Research view",
          shortcut: { prefix: "RV", argPlaceholder: "tickers", argKind: "ticker-list" },
        }),
        paneTemplate({ id: "econ", label: "Econ", shortcut: { prefix: "ECON" } }),
      ],
    });

    expect(inventory).toEqual([
      { prefix: "DES", name: "Description", description: "A command", arg: { kind: "ticker", placeholder: "ticker" } },
      { prefix: "HELP", name: "Help", description: "Open the help window" },
      { prefix: "LAY", name: "Layout Actions", description: "A command", arg: { kind: "text", placeholder: "action" } },
      { prefix: "DM", name: "DM", description: "Open a DM", arg: { kind: "text", placeholder: "@username" } },
      { prefix: "RV", name: "Research", description: "Research view", arg: { kind: "ticker-list", placeholder: "tickers" } },
      { prefix: "ECON", name: "Econ", description: "A template" },
    ]);
  });

  test("drops prefixless commands and keeps the entry the bar would run for a duplicate prefix", () => {
    const inventory = buildAssistCommandInventory({
      commands: [
        command({ prefix: "", label: "New Portfolio" }),
        command({ prefix: "  ", label: "Reset All Data" }),
        command({ prefix: "PL", label: "Manage Plugins" }),
      ],
      pluginCommands: [],
      paneTemplates: [
        paneTemplate({ id: "plugins-pane", label: "Plugin List", shortcut: { prefix: "pl" } }),
      ],
    });

    expect(inventory).toEqual([
      { prefix: "PL", name: "Manage Plugins", description: "A command" },
    ]);
  });

  test("caps the inventory at the server limit", () => {
    const inventory = buildAssistCommandInventory({
      commands: Array.from({ length: 40 }, (_, index) => command({ prefix: `C${index}` })),
      pluginCommands: [],
      paneTemplates: [],
      limit: 25,
    });

    expect(inventory).toHaveLength(25);
    expect(inventory.at(-1)?.prefix).toBe("C24");
  });
});
