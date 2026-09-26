import type { CommandDef } from "../../../types/plugin";
import { commands as coreCommands } from "../../../components/command-bar/commands/registry";
import { getSharedRegistry } from "../../registry";

export interface HelpShortcutEntry {
  id: string;
  badges: string[];
  description: string;
  category: string;
}

type SharedRegistry = ReturnType<typeof getSharedRegistry>;

export function resolveWindowTemplates(registry: SharedRegistry): HelpShortcutEntry[] {
  if (!registry || !registry.paneTemplates) return [];

  const disabledPlugins = resolveDisabledPlugins(registry);
  const allPlugins = registry.allPlugins ?? new Map<string, { name?: string }>();

  return [...registry.paneTemplates.values()]
    .filter((template) => template.shortcut)
    .filter((template) => {
      const pluginId = registry.getPaneTemplatePluginId?.(template.id);
      return !pluginId || !disabledPlugins.has(pluginId);
    })
    .map((template) => {
      const shortcut = template.shortcut!;
      const pluginId = registry.getPaneTemplatePluginId?.(template.id);
      const pluginName = pluginId ? allPlugins.get(pluginId)?.name : null;
      return {
        id: template.id,
        badges: [
          shortcut.prefix,
          shortcut.argPlaceholder ? `<${shortcut.argPlaceholder}>` : null,
        ].filter((value): value is string => !!value),
        description: template.label,
        category: pluginName ?? "Core Panes",
      };
    })
    .sort(sortShortcutEntries);
}

function resolveDisabledPlugins(registry: SharedRegistry): Set<string> {
  try {
    return new Set(registry?.getConfigFn?.().disabledPlugins ?? []);
  } catch {
    return new Set();
  }
}

function formatPlaceholder(value: string | undefined): string | null {
  return value ? `<${value}>` : null;
}

function formatShortcutDescription(description: string | undefined): string {
  return description?.trim() || "Run command";
}

function sortShortcutEntries(left: HelpShortcutEntry, right: HelpShortcutEntry): number {
  return left.category.localeCompare(right.category)
    || left.badges.join(" ").localeCompare(right.badges.join(" "))
    || left.description.localeCompare(right.description);
}

export function resolveCommandShortcuts(registry: SharedRegistry): HelpShortcutEntry[] {
  const coreRows: HelpShortcutEntry[] = coreCommands
    .filter((command) => command.prefix.trim().length > 0)
    .map((command) => ({
      id: `core:${command.id}`,
      badges: [
        command.prefix.toUpperCase(),
        formatPlaceholder(command.argPlaceholder),
      ].filter((value): value is string => !!value),
      description: command.description,
      category: command.category,
    }));

  if (!registry || !registry.commands) return coreRows;

  const disabledPlugins = resolveDisabledPlugins(registry);
  const allPlugins = registry.allPlugins ?? new Map<string, { name?: string }>();
  const pluginRows = [...registry.commands.values()]
    .filter((command: CommandDef) => command.shortcut?.trim().length)
    .filter((command: CommandDef) => {
      const pluginId = registry.getCommandPluginId?.(command.id);
      if (pluginId && disabledPlugins.has(pluginId)) return false;
      return !(command.hidden?.() ?? false);
    })
    .map((command: CommandDef) => {
      const pluginId = registry.getCommandPluginId?.(command.id);
      const pluginName = pluginId ? allPlugins.get(pluginId)?.name : null;
      return {
        id: `plugin-command:${command.id}`,
        badges: [
          command.shortcut!.toUpperCase(),
          formatPlaceholder(command.shortcutArg?.placeholder),
        ].filter((value): value is string => !!value),
        description: formatShortcutDescription(command.label),
        category: pluginName ?? command.category,
      };
    })
    .sort(sortShortcutEntries);

  return [...coreRows, ...pluginRows];
}

export function groupShortcutEntries(entries: HelpShortcutEntry[]): Array<{ title: string; entries: HelpShortcutEntry[] }> {
  const groups = new Map<string, HelpShortcutEntry[]>();
  for (const entry of entries) {
    const category = entry.category || "Other";
    groups.set(category, [...(groups.get(category) ?? []), entry]);
  }
  return [...groups.entries()]
    .map(([title, groupedEntries]) => ({ title, entries: groupedEntries }))
    .sort((left, right) => left.title.localeCompare(right.title));
}
