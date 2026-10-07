/**
 * Which function `HELP` followed by a mnemonic, and F1, mean. Every mnemonic
 * the command bar runs (core commands, plugin commands, pane templates)
 * resolves to one function, keyed by its primary mnemonic, with its help card
 * when the app ships one. A plugin function without a card still gets one
 * from what it registered.
 */
import { commands as builtInCommands, getCommandPrefixes, type Command } from "../../../components/command-bar/commands/registry";
import { FUNCTION_HELP, type FunctionHelp } from "../../../cli/pane-functions/function-help";
import { usageFunctionForPane } from "../../../telemetry/usage-counts";
import type { CommandDef, PaneTemplateDef } from "../../../types/plugin";
import type { PluginRegistry } from "../../registry";

export interface HelpFunction {
  /** The primary mnemonic: CTM for CT. */
  code: string;
  name: string;
  /** What the function registered, for a card the app does not ship. */
  description: string;
  /** Other mnemonics that open it. */
  aliases: string[];
  /** The pane it opens, when it opens one. */
  paneId?: string;
  argPlaceholder?: string;
  argOptional?: boolean;
  help: FunctionHelp | null;
}

export interface HelpFunctionSources {
  commands?: readonly Command[];
  pluginCommands: Iterable<CommandDef>;
  paneTemplates: Iterable<PaneTemplateDef>;
}

/** Every mnemonic and alias, upper-cased, to the function it runs. */
export type HelpFunctionIndex = ReadonlyMap<string, HelpFunction>;

/** Panes the core commands open; templates name their own. */
const COMMAND_PANES: Record<string, string> = {
  "security-description": "ticker-research",
  help: "help",
  "layout-marketplace": "layout-marketplace",
};

const HELP_CODE = "HELP";

function normalizeToken(value: string): string {
  return value.trim().toUpperCase();
}

function withHelp(fn: Omit<HelpFunction, "help">): HelpFunction {
  return { ...fn, help: FUNCTION_HELP[fn.code] ?? null };
}

/**
 * Registers mnemonics in the order the command bar prefers them: core
 * commands, then plugin commands, then templates. A mnemonic already taken
 * keeps its first owner, so T, the DES alias, is DES and not the Ticker
 * Research template.
 */
export function buildHelpFunctionIndex(sources: HelpFunctionSources): HelpFunctionIndex {
  const functions: HelpFunction[] = [];
  for (const command of sources.commands ?? builtInCommands) {
    const [code, ...aliases] = getCommandPrefixes(command);
    if (!code) continue;
    functions.push(withHelp({
      code,
      name: command.label,
      description: command.description,
      aliases,
      paneId: COMMAND_PANES[command.id],
      argPlaceholder: command.hasArg ? command.argPlaceholder : undefined,
    }));
  }
  for (const command of sources.pluginCommands) {
    const code = command.shortcut ? normalizeToken(command.shortcut) : "";
    if (!code) continue;
    functions.push(withHelp({
      code,
      name: command.label,
      description: command.description ?? "",
      aliases: [],
      argPlaceholder: command.shortcutArg?.placeholder,
    }));
  }
  for (const template of sources.paneTemplates) {
    const code = template.shortcut?.prefix ? normalizeToken(template.shortcut.prefix) : "";
    if (!code) continue;
    functions.push(withHelp({
      code,
      name: template.label,
      description: template.description,
      aliases: (template.shortcut?.aliases ?? []).map(normalizeToken).filter(Boolean),
      paneId: template.paneId,
      argPlaceholder: template.shortcut?.argPlaceholder
        ?? (template.shortcut?.argKind === "ticker-list" ? "tickers" : template.shortcut?.argKind),
      argOptional: template.shortcut?.argOptional,
    }));
  }

  const index = new Map<string, HelpFunction>();
  for (const fn of functions) {
    for (const token of [fn.code, ...fn.aliases]) {
      if (!index.has(token)) index.set(token, fn);
    }
  }
  return index;
}

/** The index for what is registered right now, built-in and installed plugins alike. */
export function buildRegistryHelpIndex(
  registry: Pick<PluginRegistry, "commands" | "paneTemplates">,
): HelpFunctionIndex {
  return buildHelpFunctionIndex({
    pluginCommands: registry.commands.values(),
    paneTemplates: registry.paneTemplates.values(),
  });
}

/** The functions the index knows, once each. */
export function listHelpFunctions(index: HelpFunctionIndex): HelpFunction[] {
  return [...new Set(index.values())];
}

export type HelpRequest =
  /** `HELP` alone: the Help pane, as before. */
  | { kind: "pane" }
  /** `HELP HELP`: help with the help, which is support. */
  | { kind: "support" }
  | { kind: "function"; fn: HelpFunction }
  /** No mnemonic matched: the functions whose name or description does. */
  | { kind: "search"; query: string; matches: HelpFunction[] };

const MAX_SEARCH_MATCHES = 8;

function searchScore(fn: HelpFunction, terms: string[]): number {
  const name = fn.name.toLowerCase();
  const text = `${name} ${fn.description.toLowerCase()} ${fn.help?.summary.toLowerCase() ?? ""}`;
  // "options" is OMON before it is Options Flow.
  let score = name === terms.join(" ") ? 4 : 0;
  for (const term of terms) {
    const upper = term.toUpperCase();
    if (fn.code === upper || fn.aliases.includes(upper)) score += 8;
    else if (fn.code.startsWith(upper)) score += 4;
    else if (name.split(/[^a-z0-9]+/).some((word) => word.startsWith(term))) score += 3;
    else if (text.includes(term)) score += 1;
    else return 0;
  }
  return score;
}

/**
 * What `HELP <arg>` asks for. The argument is a mnemonic or an alias
 * (`HELP OMON`, `HELP ct`), a mnemonic followed by its own argument
 * (`HELP OMON NVDA`), or words to look a function up by (`HELP options`).
 */
export function parseHelpArgument(arg: string, index: HelpFunctionIndex): HelpRequest {
  const query = arg.trim();
  if (!query) return { kind: "pane" };
  const exact = index.get(normalizeToken(query))
    ?? index.get(normalizeToken(query.split(/\s+/)[0] ?? ""));
  if (exact) return exact.code === HELP_CODE ? { kind: "support" } : { kind: "function", fn: exact };

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = listHelpFunctions(index)
    .filter((fn) => fn.code !== HELP_CODE)
    .map((fn) => ({ fn, score: searchScore(fn, terms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.fn.code.localeCompare(right.fn.code))
    .slice(0, MAX_SEARCH_MATCHES)
    .map(({ fn }) => fn);
  return { kind: "search", query, matches };
}

/**
 * The function a pane instance stands for. A pane several functions open
 * (charts, TAS and QR) is told apart by its title, which starts with the
 * mnemonic that opened it ("GP AAPL", "QR MSFT"); otherwise it is the pane's
 * first function, as usage counts see it.
 */
export function helpFunctionForPane(
  index: HelpFunctionIndex,
  registry: Parameters<typeof usageFunctionForPane>[0],
  instance: { paneId: string; title?: string },
): HelpFunction | null {
  const titleToken = normalizeToken(instance.title?.trim().split(/\s+/)[0] ?? "");
  const byTitle = titleToken ? index.get(titleToken) : undefined;
  if (byTitle?.paneId === instance.paneId) return byTitle;
  const code = usageFunctionForPane(registry, instance.paneId).shortcut;
  const byPane = code ? index.get(normalizeToken(code)) : undefined;
  if (byPane) return byPane;
  return listHelpFunctions(index).find((fn) => fn.paneId === instance.paneId) ?? null;
}
