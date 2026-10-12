import type { PluginRegistry } from "../../../../plugins/registry";
import { describeUsageFunction, recordFunctionOpen } from "../../../../telemetry/usage-counts";
import type { CommandDef, CommandResultDef } from "../../../../types/plugin";
import type { OpenInlineConfirm } from "../../routing/confirm";
import type { ResultItem } from "../../list/model";

type NotifyFn = (body: string, options?: { type?: "info" | "success" | "error" }) => void;

interface PluginCommandConfirm {
  title: string;
  body: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

export function getAvailablePluginCommandsForState(
  pluginRegistry: PluginRegistry,
  disabledPlugins: readonly string[],
): CommandDef[] {
  const disabledPluginIds = new Set(disabledPlugins);
  return [...pluginRegistry.commands.values()]
    .filter((command) => {
      if (command.hidden?.()) return false;
      const pluginId = pluginRegistry.getCommandPluginId(command.id);
      if (pluginId && disabledPluginIds.has(pluginId)) return false;
      return true;
    });
}

/** Counts a plugin command the user ran, under its shortcut. */
export function recordPluginCommandOpen(pluginRegistry: PluginRegistry, command: CommandDef): void {
  recordFunctionOpen(describeUsageFunction(pluginRegistry, pluginRegistry.getCommandPluginId(command.id), command.shortcut));
}

export async function runPluginCommandDirect(options: {
  command: CommandDef;
  values?: Record<string, string>;
  pluginRegistry: PluginRegistry;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  notify: NotifyFn;
}): Promise<void> {
  try {
    await options.command.execute(options.values);
    recordPluginCommandOpen(options.pluginRegistry, options.command);
    options.closeAll({ revertThemePreview: false });
  } catch (error) {
    options.notify(
      error instanceof Error ? error.message : `Could not run ${options.command.label.toLowerCase()}.`,
      { type: "error" },
    );
  }
}

function parsePluginCommandShortcutArg(
  command: CommandDef,
  shortcutArg: string,
  activeTicker: string | null,
): Record<string, string> {
  return command.shortcutArg?.parse?.(shortcutArg, {
    activeTicker,
  }) ?? (shortcutArg.trim() ? { shortcut: shortcutArg } : {});
}

export function buildPluginCommandItem(options: {
  command: CommandDef;
  shortcutArg?: string;
  activeTicker: string | null;
  pluginRegistry: PluginRegistry;
  openPluginCommandWorkflow: (command: CommandDef, options?: { values?: Record<string, string> }) => void;
  resolvePluginCommandConfirm: (command: CommandDef) => PluginCommandConfirm | null;
  openInlineConfirm: OpenInlineConfirm;
  runPluginCommandDirect: (command: CommandDef, values?: Record<string, string>) => void;
  notify: NotifyFn;
}): ResultItem {
  const pluginId = options.pluginRegistry.getCommandPluginId(options.command.id);
  const pluginName = pluginId ? options.pluginRegistry.allPlugins.get(pluginId)?.name : null;
  const shortcut = options.command.shortcut?.trim() || undefined;
  const shortcutArg = options.shortcutArg?.trim() || "";
  return {
    id: options.command.id,
    label: options.command.label,
    detail: shortcutArg || options.command.description || "",
    category: pluginName || "Plugin Commands",
    kind: "command",
    right: shortcut,
    shortcutQuery: shortcut,
    searchText: `${options.command.label} ${options.command.description || ""} ${(options.command.keywords ?? []).join(" ")} ${shortcut || ""}`,
    action: () => {
      if (shortcutArg && options.command.wizard && options.command.wizard.length > 0) {
        try {
          options.openPluginCommandWorkflow(options.command, {
            values: parsePluginCommandShortcutArg(options.command, shortcutArg, options.activeTicker),
          });
        } catch (error) {
          options.notify(
            error instanceof Error ? error.message : `Could not parse ${options.command.label.toLowerCase()}.`,
            { type: "error" },
          );
        }
        return;
      }
      if (shortcutArg) {
        try {
          options.runPluginCommandDirect(
            options.command,
            parsePluginCommandShortcutArg(options.command, shortcutArg, options.activeTicker),
          );
        } catch (error) {
          options.notify(
            error instanceof Error ? error.message : `Could not parse ${options.command.label.toLowerCase()}.`,
            { type: "error" },
          );
        }
        return;
      }
      if (options.command.wizard && options.command.wizard.length > 0) {
        const values = parsePluginCommandShortcutArg(options.command, "", options.activeTicker);
        options.openPluginCommandWorkflow(options.command, { values });
        return;
      }
      const confirm = options.resolvePluginCommandConfirm(options.command);
      if (confirm) {
        options.openInlineConfirm({
          confirmId: `plugin-command:${options.command.id}`,
          title: confirm.title,
          body: confirm.body,
          confirmLabel: confirm.confirmLabel || options.command.label,
          cancelLabel: confirm.cancelLabel || "Back",
          tone: confirm.tone || "danger",
          onConfirm: async () => {
            await options.command.execute();
            recordPluginCommandOpen(options.pluginRegistry, options.command);
          },
        });
        return;
      }
      options.runPluginCommandDirect(options.command);
    },
  };
}

export function buildPluginCommandResultItem(options: {
  command: CommandDef;
  result: CommandResultDef;
  pluginRegistry: PluginRegistry;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  notify: NotifyFn;
}): ResultItem {
  const pluginId = options.pluginRegistry.getCommandPluginId(options.command.id);
  const pluginName = pluginId ? options.pluginRegistry.allPlugins.get(pluginId)?.name : null;
  const category = options.result.category ?? pluginName ?? options.command.label;
  return {
    id: `plugin-command-result:${options.command.id}:${options.result.id}`,
    label: options.result.label,
    detail: options.result.detail ?? options.command.description ?? "",
    category,
    kind: "command",
    badge: options.result.badge,
    name: options.result.name,
    right: (options.result.right ?? options.command.shortcut?.trim()) || undefined,
    searchText: `${options.result.label} ${options.result.detail || ""} ${options.result.name || ""} ${(options.result.keywords ?? []).join(" ")} ${options.command.label} ${options.command.description || ""} ${(options.command.keywords ?? []).join(" ")}`,
    disabled: options.result.disabled,
    current: options.result.current,
    action: async () => {
      try {
        await options.result.execute();
        recordPluginCommandOpen(options.pluginRegistry, options.command);
        options.closeAll({ revertThemePreview: false });
      } catch (error) {
        options.notify(
          error instanceof Error ? error.message : `Could not run ${options.command.label.toLowerCase()}.`,
          { type: "error" },
        );
      }
    },
  };
}
