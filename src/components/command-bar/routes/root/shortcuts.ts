import type { CommandDef, PaneTemplateDef } from "../../../../types/plugin";
import { readTerminalListingCode } from "../../../../tickers/terminal-codes";
import { getCommandPrefixes, type Command } from "../../commands/registry";
import { getPaneTemplateDisplayLabel, paneTemplateShortcutPrefixes } from "../../pane-templates/items";

export type RootShortcutArgKind = "text" | "ticker" | "ticker-list";
type ShortcutIntentKind = "none" | "complete" | "inferred-complete" | "partial" | "ambiguous";

interface ShortcutIntentBase {
  kind: Exclude<ShortcutIntentKind, "none">;
  prefix: string;
  label: string;
  description: string;
  argKind: RootShortcutArgKind | null;
  argPlaceholder?: string;
  argText: string;
  completionQuery: string | null;
  /** The ticker in focus the argument was filled with, when none was typed. */
  inferredArg?: string;
}

interface CommandShortcutIntent extends ShortcutIntentBase {
  source: "command";
  command: Command;
}

interface PaneTemplateShortcutIntent extends ShortcutIntentBase {
  source: "pane-template";
  template: PaneTemplateDef;
}

interface PluginCommandShortcutIntent extends ShortcutIntentBase {
  source: "plugin-command";
  command: CommandDef;
}

export type ShortcutIntent =
  | { kind: "none" }
  | CommandShortcutIntent
  | PaneTemplateShortcutIntent
  | PluginCommandShortcutIntent;

interface ShortcutParseCandidate {
  prefix: string;
  label: string;
  description: string;
  argKind: RootShortcutArgKind | null;
  argPlaceholder?: string;
  source: "command" | "pane-template" | "plugin-command";
  command?: Command;
  pluginCommand?: CommandDef;
  template?: PaneTemplateDef;
}

function normalizeShortcutPrefix(value: string): string {
  return value.trim().toUpperCase();
}

function mapPlaceholderToArgKind(value: string | undefined): RootShortcutArgKind | null {
  if (value === "ticker") return "ticker";
  if (value === "tickers") return "ticker-list";
  if (value) return "text";
  return null;
}

export function getPaneShortcutArgKind(template: PaneTemplateDef): RootShortcutArgKind | null {
  return template.shortcut?.argKind ?? mapPlaceholderToArgKind(template.shortcut?.argPlaceholder);
}

export function getCommandShortcutArgKind(command: Command): RootShortcutArgKind | null {
  return mapPlaceholderToArgKind(command.argPlaceholder) ?? (command.hasArg ? "text" : null);
}

export function getPluginCommandShortcutArgKind(command: CommandDef): RootShortcutArgKind | null {
  return command.shortcutArg?.kind ?? (command.shortcutArg ? "text" : null);
}

function inferShortcutArg(argKind: RootShortcutArgKind | null, activeTicker: string | null, issuer = false): string | null {
  if (!activeTicker) return null;
  if (argKind === "ticker" || argKind === "ticker-list" || (issuer && argKind === "text")) {
    return activeTicker;
  }
  return null;
}

/** A plain ticker, as one word: NFE, BRK.B, 0700, VOD:LSE. */
const TICKER_WORD = /^\$?[A-Za-z0-9][A-Za-z0-9.\-]{0,11}(?::[A-Za-z0-9]{1,8})?$/;

/**
 * The ticker a query names before a function code, Bloomberg's word order:
 * `NFE CDS` and `NFE US Equity CDS` are `CDS NFE`. The ticker is one word or
 * a terminal code (`NFE US Equity`, `VOD LN`), read as its listing. Null for
 * anything else, so a company's name stays a search.
 */
function tickerBeforeCode(text: string): string | null {
  const words = text.trim().split(/\s+/);
  if (words.length === 1) return TICKER_WORD.test(words[0]!) ? words[0]!.replace(/^\$/, "").toUpperCase() : null;
  return readTerminalListingCode(text)?.key ?? null;
}

function buildShortcutCandidates(
  commands: Command[],
  pluginCommands: CommandDef[],
  paneTemplates: PaneTemplateDef[],
): ShortcutParseCandidate[] {
  return [
    ...commands
      .flatMap((command) => getCommandPrefixes(command).map((prefix) => ({
        prefix: normalizeShortcutPrefix(prefix),
        label: command.label,
        description: command.description,
        argKind: getCommandShortcutArgKind(command),
        argPlaceholder: command.argPlaceholder,
        source: "command" as const,
        command,
      }))),
    ...pluginCommands
      .filter((command) => command.shortcut?.trim().length)
      .map((command) => ({
        prefix: normalizeShortcutPrefix(command.shortcut!),
        label: command.label,
        description: command.description ?? "",
        argKind: getPluginCommandShortcutArgKind(command),
        argPlaceholder: command.shortcutArg?.placeholder,
        source: "plugin-command" as const,
        pluginCommand: command,
      })),
    ...paneTemplates
      .filter((template) => template.shortcut?.prefix)
      .flatMap((template) => paneTemplateShortcutPrefixes(template).map((prefix) => ({
        prefix: normalizeShortcutPrefix(prefix),
        label: getPaneTemplateDisplayLabel(template),
        description: template.description,
        argKind: getPaneShortcutArgKind(template),
        argPlaceholder: template.shortcut?.argPlaceholder,
        source: "pane-template" as const,
        template,
      }))),
  ].sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * The function code the text starts with, whatever follows it: `MOST foo`
 * leads with MOST though MOST takes no argument. Null for any other text.
 */
export function leadingShortcutCode({
  query,
  commands,
  pluginCommands = [],
  paneTemplates,
}: {
  query: string;
  commands: Command[];
  pluginCommands?: CommandDef[];
  paneTemplates: PaneTemplateDef[];
}): string | null {
  const first = query.trim().split(/\s+/)[0]?.toUpperCase();
  if (!first) return null;
  return buildShortcutCandidates(commands, pluginCommands, paneTemplates)
    .find((candidate) => candidate.prefix === first)?.prefix ?? null;
}

/** What a shortcut opens with: the argument typed, else the ticker in focus an issuer's function took. */
export function shortcutArgument(intent: Exclude<ShortcutIntent, { kind: "none" }>): string {
  return intent.argText || intent.inferredArg || "";
}

/** A function whose argument is a company it reports on, which opens on the ticker in focus when none is typed. */
function takesIssuer(template: PaneTemplateDef | undefined): boolean {
  return template?.shortcut?.focusedIssuer === true;
}

export function parseRootShortcutIntent({
  query,
  commands,
  pluginCommands = [],
  paneTemplates,
  activeTicker,
  promptTicker = null,
}: {
  query: string;
  commands: Command[];
  pluginCommands?: CommandDef[];
  paneTemplates: PaneTemplateDef[];
  activeTicker: string | null;
  /** The command prompt's instrument, used when a pane requires a ticker and the focused pane has none. */
  promptTicker?: string | null;
}): ShortcutIntent {
  const typed = query.trim();
  if (!typed) return { kind: "none" };

  const candidates = buildShortcutCandidates(commands, pluginCommands, paneTemplates);
  const leading = (text: string) => {
    const upper = text.toUpperCase();
    return candidates.find((candidate) => {
      if (upper === candidate.prefix) return true;
      return !!candidate.argKind && upper.startsWith(`${candidate.prefix} `);
    });
  };
  let trimmed = typed;
  let match = leading(trimmed);
  if (!match) {
    // Bloomberg's order, the ticker first: `NFE CDS`, `NFE US Equity CDS`.
    const words = typed.split(/\s+/);
    const code = words.length > 1 ? words.at(-1)!.toUpperCase() : "";
    const trailing = candidates.find((candidate) => candidate.prefix === code && candidate.argKind
      && (candidate.argKind !== "text" || takesIssuer(candidate.template)));
    const ticker = trailing ? tickerBeforeCode(words.slice(0, -1).join(" ")) : null;
    if (!trailing || !ticker) return { kind: "none" };
    trimmed = `${trailing.prefix} ${ticker}`;
    match = trailing;
  }

  const argText = trimmed.slice(match.prefix.length).trim();
  // A pane that requires a ticker takes the one already in the prompt, and so
  // does one that takes an issuer (CDS, TRACE). Another optional ticker stays
  // unbound, and other commands keep the focused ticker.
  const issuer = takesIssuer(match.template);
  const inferFrom = match.source === "pane-template"
    ? (match.template?.shortcut?.argOptional && !issuer ? null : (promptTicker ?? activeTicker))
    : activeTicker;
  const inferredArg = inferShortcutArg(match.argKind, inferFrom, issuer);
  const completionQuery = inferredArg ? `${match.prefix} ${inferredArg}` : null;

  let kind: Exclude<ShortcutIntentKind, "none">;
  if (argText.length > 0) {
    kind = match.argKind === "ticker-list" && /[,\n]\s*$/.test(trimmed) ? "partial" : "complete";
  } else if (completionQuery) {
    kind = "inferred-complete";
  } else {
    kind = "partial";
  }

  const base: ShortcutIntentBase = {
    kind,
    prefix: match.prefix,
    label: match.label,
    description: match.description,
    argKind: match.argKind,
    argPlaceholder: match.argPlaceholder,
    argText,
    completionQuery,
    ...(kind === "inferred-complete" && inferredArg && issuer ? { inferredArg } : {}),
  };

  if (match.source === "command" && match.command) {
    return {
      ...base,
      source: "command",
      command: match.command,
    };
  }

  if (match.source === "plugin-command" && match.pluginCommand) {
    return {
      ...base,
      source: "plugin-command",
      command: match.pluginCommand,
    };
  }

  return {
    ...base,
    source: "pane-template",
    template: match.template!,
  };
}
