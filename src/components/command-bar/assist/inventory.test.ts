import { afterEach, describe, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport, type AssistCommandDescriptor } from "../../../api-client";
import { cotModule } from "../../../plugins/builtin/cot";
import { econStatisticsModule } from "../../../plugins/builtin/econ-statistics";
import { futuresCurveModule } from "../../../plugins/builtin/futures-curve";
import { marketValuationModule } from "../../../plugins/builtin/market-valuation";
import { verifiedUser } from "../../../test-support/cloud-api";
import type { PaneTemplateDef } from "../../../types/plugin";
import { commands as builtInCommands, type Command } from "../commands/registry";
import { buildAssistCommandInventory } from "./inventory";

afterEach(() => {
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  apiClient.dispose();
});

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
    // Option sources can carry more than the endpoint takes, like a settings
    // option's description; only the value and its label are sent.
    const roots = [{ value: "ES", label: "ES E-Mini S&P 500", description: "Front month" }];
    const inventory = buildAssistCommandInventory({
      commands: [
        command({ prefix: "DES", aliases: ["T"], label: "Description", hasArg: true, argPlaceholder: "ticker" }),
        command({ prefix: "HELP", label: "Help", description: "Open the help window" }),
        command({
          prefix: "TH",
          label: "Change Theme",
          hasArg: true,
          argPlaceholder: "theme name",
          argOptions: () => [{ value: "amber", label: "Amber" }],
        }),
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
        paneTemplate({
          id: "curve",
          label: "Futures Curve",
          shortcut: { prefix: "CTM", argPlaceholder: "root", argKind: "text", argOptional: true, argOptions: () => roots },
        }),
      ],
    });

    expect(inventory).toEqual([
      { prefix: "DES", name: "Description", description: "A command", arg: { kind: "ticker", placeholder: "ticker" } },
      { prefix: "HELP", name: "Help", description: "Open the help window" },
      {
        prefix: "TH",
        name: "Change Theme",
        description: "A command",
        arg: { kind: "text", placeholder: "theme name", options: [{ value: "amber", label: "Amber" }] },
      },
      { prefix: "DM", name: "DM", description: "Open a DM", arg: { kind: "text", placeholder: "@username" } },
      { prefix: "RV", name: "Research", description: "Research view", arg: { kind: "ticker-list", placeholder: "tickers" } },
      { prefix: "ECON", name: "Econ", description: "A template" },
      {
        prefix: "CTM",
        name: "Futures Curve",
        description: "A template",
        arg: { kind: "text", placeholder: "root", optional: true, options: [{ value: "ES", label: "ES E-Mini S&P 500" }] },
      },
    ]);
  });

  test("sends no values for a provider that throws or returns malformed ones", () => {
    const inventory = buildAssistCommandInventory({
      commands: [],
      pluginCommands: [],
      paneTemplates: [
        paneTemplate({
          id: "broken",
          label: "Broken",
          shortcut: {
            prefix: "BRK",
            argPlaceholder: "value",
            argKind: "text",
            argOptions: () => {
              throw new Error("plugin state not loaded");
            },
          },
        }),
        paneTemplate({
          id: "odd",
          label: "Odd",
          shortcut: {
            prefix: "ODD",
            argPlaceholder: "value",
            argKind: "text",
            argOptions: () => [{ value: "ok", label: "Fine" }, { value: 7, label: "Seven" }] as never,
          },
        }),
      ],
    });

    expect(inventory.map((entry) => entry.arg)).toEqual([
      { kind: "text", placeholder: "value" },
      { kind: "text", placeholder: "value", options: [{ value: "ok", label: "Fine" }] },
    ]);
  });

  test("drops prefixless commands and keeps the entry the bar would run for a prefix claimed twice", () => {
    const inventory = buildAssistCommandInventory({
      commands: [
        command({ prefix: "", label: "New Portfolio" }),
        command({ prefix: "  ", label: "Reset All Data" }),
        command({ prefix: "PL", label: "Manage Plugins" }),
        command({ prefix: "DES", aliases: ["T"], label: "Description", hasArg: true, argPlaceholder: "ticker" }),
      ],
      pluginCommands: [],
      paneTemplates: [
        paneTemplate({ id: "plugins-pane", label: "Plugin List", shortcut: { prefix: "pl" } }),
        // "T AAPL" runs DES, which claims T as an alias before any template.
        paneTemplate({ id: "ticker-pane", label: "Ticker Research", shortcut: { prefix: "t", argKind: "ticker" } }),
        // A template alias shadows a later prefix the same way.
        paneTemplate({ id: "rotation", label: "Rotation", shortcut: { prefix: "RRG", aliases: ["GRR"] } }),
        paneTemplate({ id: "rotation-copy", label: "Other Rotation", shortcut: { prefix: "grr" } }),
      ],
    });

    expect(inventory.map((entry) => `${entry.prefix} ${entry.name}`)).toEqual([
      "PL Manage Plugins",
      "DES Description",
      "RRG Rotation",
    ]);
  });

  test("sends every built-in fixed-value list whole", async () => {
    // A list past the server caps is left out of the request, and the
    // assistant is back to guessing the argument.
    const inventory = buildAssistCommandInventory({
      commands: builtInCommands,
      pluginCommands: [],
      paneTemplates: [econStatisticsModule, marketValuationModule, futuresCurveModule, cotModule]
        .flatMap((module) => module.paneTemplates ?? []),
    });
    let sent: AssistCommandDescriptor[] = [];
    apiClient.setSessionToken("inventory-test-session");
    apiClient.restoreCachedUser(verifiedUser);
    setCloudApiFetchTransport(async (_url, init) => {
      sent = (JSON.parse(String(init?.body)) as { commands: AssistCommandDescriptor[] }).commands;
      return Response.json({ candidates: [] });
    });

    await apiClient.assistCommand("dark theme", inventory);

    const listed = inventory.filter((entry) => entry.arg?.options);
    expect(listed.map((entry) => entry.prefix)).toEqual(["TH", "LANG", "ECST", "VAL", "CTM", "COT"]);
    expect(sent.filter((entry) => entry.arg?.options)).toEqual(listed);
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
