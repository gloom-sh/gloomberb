import { describe, expect, test } from "bun:test";
import { commands, type Command } from "../../commands/registry";
import { SECURITY_DESCRIPTION_SEARCH } from "../../helpers";
import { buildImmediateRootSelection } from "./selection";

const languageCommand: Command = {
  id: "language",
  prefix: "LANG",
  label: "Change Language",
  description: "Switch the interface language",
  hasArg: true,
  argPlaceholder: "locale",
  category: "Config",
};

describe("root command selection", () => {
  function selectLanguage(query: string, onRun: (arg: string) => void, options: {
    availableCommands?: Command[];
    openModeRoute?: (screen: string, query?: string, payload?: Record<string, unknown>) => void;
    runSecurityDescriptionShortcut?: (query?: string) => void;
  } = {}) {
    return buildImmediateRootSelection({
      query,
      activeTickerSymbol: null,
      availableCommands: options.availableCommands ?? [languageCommand],
      createPaneTemplateItem: () => { throw new Error("Unexpected pane template"); },
      createPluginCommandItem: () => { throw new Error("Unexpected plugin command"); },
      executeCollectionCommand: () => {},
      getAvailablePaneShortcutTemplates: () => [],
      getAvailablePluginCommands: () => [],
      openModeRoute: options.openModeRoute ?? (() => {}),
      openPaneTemplateWorkflow: () => {},
      pluginCommandResultItems: () => [],
      runDirectCommand: (_command, arg) => onRun(arg),
      runSecurityDescriptionShortcut: options.runSecurityDescriptionShortcut ?? (() => {}),
      setRootQuery: () => {},
      startThemePicker: () => {},
    });
  }

  test("passes an explicit locale argument to the language action", () => {
    const receivedArgs: string[] = [];
    const selection = selectLanguage("LANG ja", (arg) => { receivedArgs.push(arg); });

    expect(selection?.label).toBe("Change Language");
    expect(selection?.right).toBe("ja");
    selection?.action();
    expect(receivedArgs).toEqual(["ja"]);
  });

  test("DES with no ticker opens DES's own search, whose pick opens DES rather than changing the focused pane", () => {
    const opened: unknown[] = [];
    const selection = selectLanguage("DES", () => {}, {
      availableCommands: commands.filter((command) => command.id === "security-description"),
      openModeRoute: (...args) => { opened.push(args); },
    });
    selection?.action();
    expect(opened).toEqual([["ticker-search", "", SECURITY_DESCRIPTION_SEARCH]]);
  });

  // `MC FP Equity DES` showed "Shortcut: DES MC:EPA" and Enter did nothing, where `MC FP Equity GP` opens GP.
  test("DES typed after its ticker in Bloomberg's order opens DES on the listing the code names, as typed first does", () => {
    const described: Array<string | undefined> = [];
    const select = (query: string) => selectLanguage(query, () => {}, {
      availableCommands: commands.filter((command) => command.id === "security-description"),
      runSecurityDescriptionShortcut: (arg) => { described.push(arg); },
    });
    for (const query of ["MC FP Equity DES", "VOD LN DES", "AAPL DES", "DES MC FP Equity"]) void select(query)?.action();
    expect(described).toEqual(["MC:EPA", "VOD:LSE", "AAPL", "MC FP Equity"]);
  });

  test("keeps bare LANG available for cycling", () => {
    const receivedArgs: string[] = [];
    const selection = selectLanguage("LANG", (arg) => { receivedArgs.push(arg); });

    expect(selection?.label).toBe("Change Language");
    selection?.action();
    expect(receivedArgs).toEqual([""]);
  });
});
