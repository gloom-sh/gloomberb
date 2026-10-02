import { requestFunctionHelp, type FunctionHelpRequest } from "../../../../plugins/builtin/help/function-card";
import { buildRegistryHelpIndex, parseHelpArgument, type HelpFunction } from "../../../../plugins/builtin/help/function-index";
import { getSharedRegistry } from "../../../../plugins/registry";
import { recordFunctionOpen } from "../../../../telemetry/usage-counts";
import { t, tf } from "../../../../i18n";
import type { ResultItem } from "../../list/model";

function openHelp(request: FunctionHelpRequest): () => void {
  return () => {
    recordFunctionOpen({ shortcut: "HELP", externalPluginId: null });
    requestFunctionHelp(request);
  };
}

function functionItem(fn: HelpFunction): ResultItem {
  return {
    id: `help:${fn.code}`,
    label: fn.name,
    detail: fn.help?.summary ?? fn.description,
    category: "Help",
    kind: "action",
    right: fn.code,
    shortcutQuery: `HELP ${fn.code}`,
    action: openHelp({ kind: "function", fn }),
  };
}

/**
 * Rows for `HELP <arg>`: the named function's card, support for `HELP HELP`,
 * or the functions whose name or description matches the words. Empty for
 * `HELP` alone, which stays the Help pane row every command gets.
 */
export function buildHelpArgumentItems(arg: string): ResultItem[] {
  const registry = getSharedRegistry();
  if (!registry || !arg.trim()) return [];
  const request = parseHelpArgument(arg, buildRegistryHelpIndex(registry));
  switch (request.kind) {
    case "pane":
      return [];
    case "support":
      return [{
        id: "help:support",
        label: t("Contact support"),
        detail: t("Send the team a message, with a screenshot if it helps"),
        category: "Help",
        kind: "action",
        right: "FB",
        action: openHelp({ kind: "support" }),
      }];
    case "function":
      return [functionItem(request.fn)];
    case "search":
      return request.matches.length > 0
        ? request.matches.map(functionItem)
        : [{
          id: "help:no-match",
          label: tf("No function matches \"{query}\"", { query: request.query }),
          detail: t("Try its mnemonic, such as HELP OMON, or a word from its name"),
          category: "Help",
          kind: "info",
          defaultSelectable: false,
          disabled: true,
          action: () => {},
        }];
  }
}
