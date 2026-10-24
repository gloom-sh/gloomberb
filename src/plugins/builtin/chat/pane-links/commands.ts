import { commands as coreCommands, getCommandPrefixes, type Command } from "../../../../components/command-bar/commands/registry";
import { getPaneTemplateDisplayLabel, paneTemplateShortcutPrefixes } from "../../../../components/command-bar/pane-templates/items";
import { getCommandShortcutArgKind, getPaneShortcutArgKind } from "../../../../components/command-bar/routes/root/shortcuts";
import type { CommandDef, PaneTemplateDef } from "../../../../types/plugin";

/**
 * A function a message can name in backticks (`NI CRYPTO`, `DES AAPL`,
 * `CRYP`): a code the command bar runs, and what it opens.
 */
export interface ChatFunction {
  /** The code the command bar lists, upper case. */
  code: string;
  /** Other codes that run the same function (T for DES). */
  aliases: readonly string[];
  /** What the function is called: the command bar's name for it. */
  name: string;
  /** Whether text after the code is its argument (a ticker, a topic). */
  takesArg: boolean;
}

/** A function named in a message, and the text the command bar runs for it. */
export interface ChatCommand {
  query: string;
  fn: ChatFunction;
}

/**
 * The commands a chip may run besides the functions that open panes: a
 * company's description and the help window. Every other command changes
 * settings or data (adds to a portfolio, switches the theme), which one click
 * on somebody else's message must never do, so its code stays text.
 */
const OPENING_COMMAND_IDS = new Set(["security-description", "help"]);

interface FunctionSource {
  paneTemplates: ReadonlyMap<string, PaneTemplateDef>;
  commands: ReadonlyMap<string, CommandDef>;
}

function upperCodes(codes: readonly string[]): string[] {
  return codes.map((code) => code.trim().toUpperCase()).filter(Boolean);
}

function commandFunction(command: Command): ChatFunction | null {
  const [code, ...aliases] = upperCodes(getCommandPrefixes(command));
  return code ? { code, aliases, name: command.label, takesArg: getCommandShortcutArgKind(command) !== null } : null;
}

/**
 * The functions of the app's own panes and plugins, by every code that runs
 * them, as the command bar matches its first word. A code the bar runs as a
 * command that is not one of those above is left out, even where a pane
 * shares it, since that command is what a click would run.
 */
export function chatFunctionsFrom(source: FunctionSource, core: readonly Command[] = coreCommands): ReadonlyMap<string, ChatFunction> {
  const byCode = new Map<string, ChatFunction>();
  const taken = new Set<string>();
  for (const command of core) {
    const codes = upperCodes(getCommandPrefixes(command));
    const fn = OPENING_COMMAND_IDS.has(command.id) ? commandFunction(command) : null;
    for (const code of codes) {
      if (fn && !taken.has(code)) byCode.set(code, fn);
      taken.add(code);
    }
  }
  for (const command of source.commands.values()) {
    const code = command.shortcut?.trim().toUpperCase();
    if (code) taken.add(code);
  }
  for (const template of source.paneTemplates.values()) {
    const [code, ...aliases] = upperCodes(paneTemplateShortcutPrefixes(template));
    if (!code) continue;
    const fn: ChatFunction = { code, aliases, name: getPaneTemplateDisplayLabel(template), takesArg: getPaneShortcutArgKind(template) !== null };
    for (const each of [code, ...aliases]) {
      if (taken.has(each)) continue;
      taken.add(each);
      byCode.set(each, fn);
    }
  }
  return byCode;
}

const NO_FUNCTIONS: ReadonlyMap<string, ChatFunction> = new Map();
const built = new WeakMap<FunctionSource, { size: string; functions: ReadonlyMap<string, ChatFunction> }>();

/** The same, built again only when a plugin adds or takes away a pane template or a command. */
export function cachedChatFunctions(source: FunctionSource | null | undefined): ReadonlyMap<string, ChatFunction> {
  if (!source) return NO_FUNCTIONS;
  const size = `${source.paneTemplates.size}:${source.commands.size}`;
  const cached = built.get(source);
  if (cached?.size === size) return cached.functions;
  const functions = chatFunctionsFrom(source);
  built.set(source, { size, functions });
  return functions;
}

interface ChatCommandHost {
  functions(): ReadonlyMap<string, ChatFunction>;
  /** Runs the text in the command bar, as if typed there and entered. */
  run(query: string): void;
}

let host: ChatCommandHost | null = null;

/** The chat plugin hands over the app's functions and its command bar. */
export function attachChatCommands(next: ChatCommandHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

export function chatFunctions(): ReadonlyMap<string, ChatFunction> {
  return host?.functions() ?? NO_FUNCTIONS;
}

export function runChatCommand(query: string): void {
  host?.run(query);
}

/** Past this a span in backticks is a sentence or code, not a function and its argument. */
const MAX_COMMAND_LENGTH = 48;

/**
 * The function a span of inline code names, or null. The code is the first
 * word, written in capitals as the app writes codes, so a key written as `n`
 * or `esc` stays code; a code of one letter needs its argument (`T AAPL`), as
 * `N` alone is more often the key than News. Words after the code are its
 * argument, which only a function that takes one accepts: the command bar
 * runs nothing for `CRYP BTC` either.
 */
export function resolveChatCommand(text: string, functions: ReadonlyMap<string, ChatFunction> = chatFunctions()): ChatCommand | null {
  const query = text.trim().replace(/[ \t]+/g, " ");
  if (!query || query.length > MAX_COMMAND_LENGTH || /[\n`]/.test(query)) return null;
  const space = query.indexOf(" ");
  const code = space < 0 ? query : query.slice(0, space);
  if (code !== code.toUpperCase()) return null;
  const fn = functions.get(code);
  if (!fn) return null;
  if (space < 0) return code.length > 1 ? { query, fn } : null;
  return fn.takesArg ? { query, fn } : null;
}
