import type { CommandDef, PaneTemplateDef } from "../../../../types/plugin";
import { chatFunctionsFrom, type ChatFunctionSource } from "./commands";

type Shortcut = NonNullable<PaneTemplateDef["shortcut"]>;
const template = (id: string, label: string, shortcut: Shortcut): [string, PaneTemplateDef] => (
  [id, { id, paneId: id, label, description: "", shortcut }]
);
const command = (id: string, shortcut: string): [string, CommandDef] => (
  [id, { id, label: id, keywords: [], category: "portfolio", shortcut, execute: () => {} }]
);

/** A few invented functions beside the app's own DES and HELP, for the tests of functions written in messages. */
export function testFunctionSource(): ChatFunctionSource & { commands: Map<string, CommandDef> } {
  return {
    paneTemplates: new Map([
      template("news-industry-pane", "Topic News", {
        prefix: "NI", argKind: "text", argOptional: true,
        argOptions: () => [{ value: "CRYPTO", label: "Crypto" }, { value: "MNA", label: "Mergers" }],
      }),
      template("crypto-board-pane", "Crypto Board", { prefix: "CRYP" }),
      template("news-feed-pane", "News Feed", { prefix: "N", aliases: ["FH"] }),
      template("price-chart-pane", "Price Chart", { prefix: "GP", argKind: "ticker" }),
      template("compare-pane", "Compare", { prefix: "CMP", argKind: "ticker-list" }),
      // Free text a function acts on as it opens: asked, not looked at.
      template("ask-pane", "Ask", { prefix: "ASK", argKind: "text" }),
      // Panes whose codes the bar runs as commands that change things; one goes by another code too.
      template("watch-pane", "Watch", { prefix: "AW", aliases: ["WTCH"] }),
      template("ticket-pane", "Ticket", { prefix: "BUY", argKind: "ticker" }),
    ]),
    commands: new Map([command("broker-buy", "BUY")]),
  };
}

export const TEST_FUNCTIONS = chatFunctionsFrom(testFunctionSource());
