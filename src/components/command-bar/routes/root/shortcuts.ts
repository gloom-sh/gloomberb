import type { CommandDef, PaneTemplateDef } from "../../../../types/plugin";
import { getCommandPrefixes, type Command } from "../../commands/registry";
import { getPaneTemplateDisplayLabel } from "../../pane-templates/items";

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

function inferShortcutArg(argKind: RootShortcutArgKind | null, activeTicker: string | null): string | null {
  if (!activeTicker) return null;
  if (argKind === "ticker" || argKind === "ticker-list") {
    return activeTicker;
  }
  return null;
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
      .map((template) => ({
        prefix: normalizeShortcutPrefix(template.shortcut!.prefix),
        label: getPaneTemplateDisplayLabel(template),
        description: template.description,
        argKind: getPaneShortcutArgKind(template),
        argPlaceholder: template.shortcut?.argPlaceholder,
        source: "pane-template" as const,
        template,
      })),
  ].sort((a, b) => b.prefix.length - a.prefix.length);
}

export function parseRootShortcutIntent({
  query,
  commands,
  pluginCommands = [],
  paneTemplates,
  activeTicker,
}: {
  query: string;
  commands: Command[];
  pluginCommands?: CommandDef[];
  paneTemplates: PaneTemplateDef[];
  activeTicker: string | null;
}): ShortcutIntent {
  const trimmed = query.trim();
  if (!trimmed) return { kind: "none" };

  const upper = trimmed.toUpperCase();
  const match = buildShortcutCandidates(commands, pluginCommands, paneTemplates).find((candidate) => {
    if (upper === candidate.prefix) return true;
    return !!candidate.argKind && upper.startsWith(`${candidate.prefix} `);
  });
  if (!match) return { kind: "none" };

  const argText = trimmed.slice(match.prefix.length).trim();
  const inferredArg = match.source === "pane-template" && match.template?.shortcut?.argOptional
    ? null
    : inferShortcutArg(match.argKind, activeTicker);
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
