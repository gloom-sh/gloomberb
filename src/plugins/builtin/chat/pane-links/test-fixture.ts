import type { CommandDef, PaneTemplateDef } from "../../../../types/plugin";
import { chatFunctionsFrom } from "./commands";

type Shortcut = NonNullable<PaneTemplateDef["shortcut"]>;
const template = (id: string, label: string, shortcut: Shortcut): [string, PaneTemplateDef] => (
  [id, { id, paneId: id, label, description: "", shortcut }]
);

/** A few invented functions beside the app's own DES and HELP, for the tests of functions written in messages. */
export const TEST_FUNCTIONS = chatFunctionsFrom({
  paneTemplates: new Map([
    template("news-industry-pane", "Topic News", { prefix: "NI", argKind: "text", argOptional: true }),
    template("crypto-board-pane", "Crypto Board", { prefix: "CRYP" }),
    template("news-feed-pane", "News Feed", { prefix: "N", aliases: ["FH"] }),
    // Panes whose codes the bar runs as commands that change things.
    template("watch-pane", "Watch", { prefix: "AW" }),
    template("ticket-pane", "Ticket", { prefix: "BUY", argKind: "ticker" }),
  ]),
  commands: new Map<string, CommandDef>([["broker-buy", { id: "broker-buy", label: "Buy", keywords: [], category: "portfolio", shortcut: "BUY", execute: () => {} }]]),
});
