import { describe, expect, test } from "bun:test";
import { commands } from "../../../components/command-bar/commands/registry";
import { parseRootShortcutIntent } from "../../../components/command-bar/routes/root/shortcuts";
import type { CommandDef, PaneTemplateDef } from "../../../types/plugin";
import { buildHelpFunctionIndex, parseHelpArgument, type HelpRequest } from "./function-index";

function template(id: string, paneId: string, label: string, prefix: string, aliases?: string[]): PaneTemplateDef {
  return { id, paneId, label, description: `${label}.`, shortcut: { prefix, aliases, argKind: "ticker" } } as PaneTemplateDef;
}

const paneTemplates = [
  template("options-pane", "options", "Options", "OMON"),
  template("options-calculator-pane", "options-calculator", "Options Calculator", "OVME"),
  template("futures-curve-pane", "futures-curve", "Futures Curve", "CTM", ["CT"]),
  template("new-ticker-detail-pane", "ticker-research", "Ticker Research", "T"),
];
const pluginCommands = [{ id: "twitter-feed-open", label: "X Feed", shortcut: "TWIT" } as CommandDef];
const index = buildHelpFunctionIndex({ pluginCommands, paneTemplates });

function code(request: HelpRequest): string | null {
  return request.kind === "function" ? request.fn.code : null;
}

describe("HELP <arg>", () => {
  test("alone opens the Help pane, twice opens support", () => {
    expect(parseHelpArgument("", index)).toEqual({ kind: "pane" });
    expect(parseHelpArgument("  ", index)).toEqual({ kind: "pane" });
    expect(parseHelpArgument("HELP", index)).toEqual({ kind: "support" });
    expect(parseHelpArgument("hl", index)).toEqual({ kind: "support" });
  });

  test("a mnemonic or alias names its function, whatever follows it", () => {
    expect(code(parseHelpArgument("OMON", index))).toBe("OMON");
    expect(code(parseHelpArgument("omon nvda", index))).toBe("OMON");
    expect(code(parseHelpArgument("ct", index))).toBe("CTM");
    expect(code(parseHelpArgument("TWIT", index))).toBe("TWIT");
    // T is the DES alias before it is the Ticker Research template, as in the bar.
    expect(code(parseHelpArgument("T", index))).toBe("DES");
  });

  test("words look the function up by name", () => {
    const request = parseHelpArgument("options calc", index);
    expect(request.kind === "search" ? request.matches.map((fn) => fn.code) : null).toEqual(["OVME"]);
    const none = parseHelpArgument("zzz", index);
    expect(none.kind === "search" ? none.matches : null).toEqual([]);
  });

  test("the command bar reads HELP OMON as HELP with an argument", () => {
    const intent = parseRootShortcutIntent({ query: "HELP OMON", commands, paneTemplates, activeTicker: null });
    expect(intent.kind === "complete" && intent.source === "command"
      ? [intent.command.id, intent.argText]
      : null).toEqual(["help", "OMON"]);
  });
});
