import { useSyncExternalStore } from "react";
import { commands as coreCommands, getCommandPrefixes, type Command } from "../../../../components/command-bar/commands/registry";
import { getPaneTemplateDisplayLabel, paneTemplateShortcutPrefixes } from "../../../../components/command-bar/pane-templates/items";
import { getPaneShortcutArgKind } from "../../../../components/command-bar/routes/root/shortcuts";
import type { CommandDef, PaneTemplateDef } from "../../../../types/plugin";

/**
 * What a function takes after its code in a message. Only an argument that
 * names something to look at: free text is what some functions act on as they
 * open (ASKG asks it, THESIS starts one), which one click on somebody else's
 * message must never do, so those take none here.
 */
type ChatFunctionArg =
  /** Nothing: the code alone. */
  | "none"
  /** One ticker: `DES AAPL`. */
  | "ticker"
  /** One or more tickers: `CMP AAPL MSFT`. */
  | "tickers"
  /** A function's code: `HELP OMON`. */
  | "code"
  /** One of the values the function names: `NI CRYPTO`. */
  | "choice";

/**
 * A function a message can name in backticks (`NI CRYPTO`, `DES AAPL`,
 * `CRYP`): a code the command bar runs, and what it opens.
 */
export interface ChatFunction {
  /** The code to write for it, upper case. */
  code: string;
  /** Other codes that run the same function (T for DES). */
  aliases: readonly string[];
  /** What the function is called: the command bar's name for it. */
  name: string;
  arg: ChatFunctionArg;
  /** For a choice, the values it takes. */
  choices?: () => readonly string[];
  /** Written as a chip when someone types it, but never suggested (`listed: false`). */
  unlisted?: true;
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
const OPENING_COMMAND_ARGS = new Map<string, ChatFunctionArg>([["security-description", "ticker"], ["help", "code"]]);

export interface ChatFunctionSource {
  paneTemplates: ReadonlyMap<string, PaneTemplateDef>;
  commands: ReadonlyMap<string, CommandDef>;
  /** Plugins switched off: the bar opens none of their functions, so they draw no chip. */
  disabledPlugins?: readonly string[];
  /** Whether a template's plugin (or its pane's) is one of those switched off. */
  isTemplateOff?: (templateId: string) => boolean;
}

function upperCodes(codes: readonly string[]): string[] {
  return codes.map((code) => code.trim().toUpperCase()).filter(Boolean);
}

function templateArg(template: PaneTemplateDef): Pick<ChatFunction, "arg" | "choices"> {
  const kind = getPaneShortcutArgKind(template);
  if (kind === "ticker") return { arg: "ticker" };
  if (kind === "ticker-list") return { arg: "tickers" };
  const options = template.shortcut?.argOptions;
  if (kind === "text" && options) return { arg: "choice", choices: () => options().map((option) => option.value) };
  return { arg: "none" };
}

/**
 * The functions of the app's own panes and plugins, by every code that runs
 * them, as the command bar matches its first word. A code the bar runs as a
 * command that is not one of those above is left out, even where a pane
 * shares it, since that command is what a click would run.
 */
export function chatFunctionsFrom(source: ChatFunctionSource, core: readonly Command[] = coreCommands): ReadonlyMap<string, ChatFunction> {
  const byCode = new Map<string, ChatFunction>();
  const taken = new Set<string>();
  const add = (codes: readonly string[], fn: Omit<ChatFunction, "code" | "aliases"> | null) => {
    const free = codes.filter((code) => !taken.has(code));
    for (const code of codes) taken.add(code);
    // A code of one letter only counts with its argument (`T AAPL`), so a
    // function that takes none is written with a longer one (FH for N).
    const usable = fn ? free.filter((code) => code.length > 1 || fn.arg !== "none") : [];
    const [code, ...aliases] = usable;
    if (!fn || !code) return;
    const entry: ChatFunction = { ...fn, code, aliases };
    for (const each of usable) byCode.set(each, entry);
  };
  for (const command of core) {
    const arg = OPENING_COMMAND_ARGS.get(command.id);
    add(upperCodes(getCommandPrefixes(command)), arg ? { name: command.label, arg } : null);
  }
  for (const command of source.commands.values()) {
    const code = command.shortcut?.trim().toUpperCase();
    if (code) taken.add(code);
  }
  for (const template of source.paneTemplates.values()) {
    // A switched-off plugin's code opens nothing until it is turned on, and
    // leaves the code to a function that does.
    if (source.isTemplateOff?.(template.id)) continue;
    add(upperCodes(paneTemplateShortcutPrefixes(template)), {
      name: getPaneTemplateDisplayLabel(template),
      ...templateArg(template),
      ...(template.listed === false ? { unlisted: true as const } : {}),
    });
  }
  return byCode;
}

/**
 * Everything the functions are built from, in one string: a plugin swapped,
 * a code moved to a command or a plugin switched off changes it, where the
 * number of templates and commands may stay the same.
 */
function sourceSignature(source: ChatFunctionSource): string {
  let signature = source.disabledPlugins?.join(",") ?? "";
  for (const [id, template] of source.paneTemplates) {
    const shortcut = template.shortcut;
    if (!shortcut?.prefix) continue;
    signature += `\n${id} ${shortcut.prefix} ${shortcut.aliases?.join(",") ?? ""} ${shortcut.argKind ?? shortcut.argPlaceholder ?? ""}${shortcut.argOptions ? " ?" : ""}`;
  }
  for (const command of source.commands.values()) {
    if (command.shortcut) signature += `\n:${command.shortcut}`;
  }
  return signature;
}

const NO_FUNCTIONS: ReadonlyMap<string, ChatFunction> = new Map();
const built = new WeakMap<object, { signature: string; functions: ReadonlyMap<string, ChatFunction> }>();

/** The same, built again only when what they are built from changes. */
export function cachedChatFunctions(source: ChatFunctionSource | null | undefined): ReadonlyMap<string, ChatFunction> {
  if (!source) return NO_FUNCTIONS;
  const signature = sourceSignature(source);
  const cached = built.get(source.paneTemplates);
  if (cached?.signature === signature) return cached.functions;
  const functions = chatFunctionsFrom(source);
  built.set(source.paneTemplates, { signature, functions });
  return functions;
}

interface ChatCommandHost {
  functions(): ReadonlyMap<string, ChatFunction>;
  /** Runs the text in the command bar, as if typed there and entered. */
  run(query: string): void;
}

let host: ChatCommandHost | null = null;
const listeners = new Set<() => void>();
/** The functions messages are drawn with, read again when the app's plugins or settings change. */
let drawn: ReadonlyMap<string, ChatFunction> = NO_FUNCTIONS;

/**
 * Tells the messages already drawn that the functions may have changed (a
 * plugin came in late, or was switched off); only those that did redraw.
 */
export function chatFunctionsChanged(): void {
  const next = chatFunctions();
  if (next === drawn) return;
  drawn = next;
  for (const listener of [...listeners]) listener();
}

/** The chat plugin hands over the app's functions and its command bar. */
export function attachChatCommands(next: ChatCommandHost): () => void {
  host = next;
  chatFunctionsChanged();
  return () => {
    if (host !== next) return;
    host = null;
    chatFunctionsChanged();
  };
}

function chatFunctions(): ReadonlyMap<string, ChatFunction> {
  return host?.functions() ?? NO_FUNCTIONS;
}

function subscribeChatFunctions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const drawnFunctions = () => drawn;

/**
 * The functions, for a view that draws them: it redraws when they change.
 * Every line of every message reads them, so they are not built again here;
 * a click checks its function against the app as it is then.
 */
export function useChatFunctions(): ReadonlyMap<string, ChatFunction> {
  return useSyncExternalStore(subscribeChatFunctions, drawnFunctions, drawnFunctions);
}

/**
 * Runs a function a chip names, if it is still one: what the bar runs for
 * the code may have changed since the message was drawn.
 */
export function runChatCommand(query: string): void {
  const command = resolveChatCommand(query);
  if (command) host?.run(command.query);
}

/** Past this a span in backticks is a sentence or code, not a function and its argument. */
const MAX_COMMAND_LENGTH = 48;
const MAX_TICKERS = 12;
/** Marks that change how text reads without being seen: direction overrides, zero-width joiners, controls. */
const INVISIBLE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
/** A symbol as written: AAPL, BRK.B, BTC-USD, ES=F, SMSN:LSE, ^GSPC. With a letter, so `GP 100` is not one. */
const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.:=/!-]{0,23}$/;
const CODE_RE = /^[A-Z][A-Z0-9]{0,11}$/;

const isTicker = (word: string) => TICKER_RE.test(word) && /[A-Z]/.test(word);

function acceptsArg(fn: ChatFunction, arg: string): boolean {
  switch (fn.arg) {
    case "ticker":
      return isTicker(arg);
    case "tickers": {
      const words = arg.split(/[\s,]+/).filter(Boolean);
      return words.length > 0 && words.length <= MAX_TICKERS && words.every(isTicker);
    }
    case "code":
      return CODE_RE.test(arg);
    case "choice": {
      const wanted = arg.toUpperCase();
      try {
        return fn.choices?.().some((value) => value.toUpperCase() === wanted) ?? false;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

/**
 * The function a span of inline code names, or null. The code is the first
 * word, written in capitals as the app writes codes, so a key written as `n`
 * or `esc` stays code; a code of one letter needs its argument (`T AAPL`), as
 * `N` alone is more often the key than News. Words after the code are its
 * argument, which must be what the function takes: a ticker in capitals
 * (`CAT food` and `G is great` stay code), a list of them, a function's code
 * for HELP, or one of the values the function names (`NI CRYPTO`). Marks that
 * cannot be seen are dropped, so the chip shows all of the text it runs.
 */
export function resolveChatCommand(text: string, functions: ReadonlyMap<string, ChatFunction> = chatFunctions()): ChatCommand | null {
  if (/[\n`]/.test(text)) return null;
  const query = text.replace(INVISIBLE_RE, "").trim().replace(/\s+/g, " ");
  if (!query || query.length > MAX_COMMAND_LENGTH) return null;
  const space = query.indexOf(" ");
  const code = space < 0 ? query : query.slice(0, space);
  if (code !== code.toUpperCase()) return null;
  const fn = functions.get(code);
  if (!fn) return null;
  if (space < 0) return code.length > 1 ? { query, fn } : null;
  return acceptsArg(fn, query.slice(space + 1)) ? { query, fn } : null;
}
