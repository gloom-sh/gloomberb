import { useCallback } from "react";
import type { AppState } from "../../../../state/app/context";
import type { PluginRegistry } from "../../../../plugins/registry";
import type { CommandDef, CommandResultDef } from "../../../../types/plugin";
import type { OpenInlineConfirm } from "../../routing/confirm";
import { looksDestructiveCommand } from "../../helpers";
import type { ResultItem } from "../../list/model";
import {
  buildPluginCommandItem,
  buildPluginCommandResultItem,
  getAvailablePluginCommandsForState,
  runPluginCommandDirect as runPluginCommandDirectAction,
} from "./items";
import type { FormModalRequest } from "../../../form-modal";

type CloseAllFn = (options?: { revertThemePreview?: boolean }) => void;
type NotifyFn = (body: string, options?: { type?: "info" | "success" | "error" }) => void;

interface UseCommandBarPluginCommandActionsOptions {
  activeCollectionId: string | null;
  activeTickerSymbol: string | null;
  closeAll: CloseAllFn;
  config: AppState["config"];
  notify: NotifyFn;
  openForm: (request: FormModalRequest) => void;
  openInlineConfirm: OpenInlineConfirm;
  pluginRegistry: PluginRegistry;
}

export function useCommandBarPluginCommandActions({
  activeCollectionId,
  activeTickerSymbol,
  closeAll,
  config,
  notify,
  openForm,
  openInlineConfirm,
  pluginRegistry,
}: UseCommandBarPluginCommandActionsOptions) {
  const resolvePluginCommandConfirm = useCallback((command: CommandDef) => {
    const context = {
      config,
      layout: config.layout,
      activeTicker: activeTickerSymbol,
      activeCollectionId,
    };
    if (typeof command.confirm === "function") {
      return command.confirm(context);
    }
    if (command.confirm) {
      return command.confirm;
    }
    if (!looksDestructiveCommand(command)) {
      return null;
    }
    return {
      title: command.label,
      body: [command.description || `Run ${command.label.toLowerCase()}?`],
      confirmLabel: command.label,
      cancelLabel: "Back",
      tone: "danger" as const,
    };
  }, [activeCollectionId, activeTickerSymbol, config]);

  const openPluginCommandWorkflow = useCallback((
    command: CommandDef,
    options?: { values?: Record<string, string> },
  ) => {
    if (!command.wizard || command.wizard.length === 0) return;
    openForm({ kind: "plugin-command", commandId: command.id, values: options?.values });
  }, [openForm]);

  const getAvailablePluginCommands = useCallback((): CommandDef[] => {
    return getAvailablePluginCommandsForState(pluginRegistry, config.disabledPlugins || []);
  }, [config.disabledPlugins, pluginRegistry]);

  const runPluginCommandDirect = useCallback(async (
    command: CommandDef,
    values?: Record<string, string>,
  ) => {
    await runPluginCommandDirectAction({
      closeAll,
      command,
      notify,
      values,
    });
  }, [closeAll, notify]);

  const createPluginCommandItem = useCallback((
    command: CommandDef,
    options?: { shortcutArg?: string },
  ): ResultItem => buildPluginCommandItem({
    activeTicker: activeTickerSymbol,
    command,
    notify,
    openInlineConfirm,
    openPluginCommandWorkflow,
    pluginRegistry,
    resolvePluginCommandConfirm,
    runPluginCommandDirect,
    shortcutArg: options?.shortcutArg,
  }), [
    activeTickerSymbol,
    notify,
    openInlineConfirm,
    openPluginCommandWorkflow,
    pluginRegistry,
    resolvePluginCommandConfirm,
    runPluginCommandDirect,
  ]);

  const createPluginCommandResultItem = useCallback((
    command: CommandDef,
    result: CommandResultDef,
  ): ResultItem => buildPluginCommandResultItem({
    closeAll,
    command,
    notify,
    pluginRegistry,
    result,
  }), [closeAll, notify, pluginRegistry]);

  const pluginCommandResultItems = useCallback((
    command: CommandDef,
    shortcutArg: string,
  ): ResultItem[] => {
    const results = command.buildResults?.(shortcutArg) ?? [];
    return results.map((result) => createPluginCommandResultItem(command, result));
  }, [createPluginCommandResultItem]);

  const pluginCommandItems = useCallback((): ResultItem[] => {
    return getAvailablePluginCommands().map((command) => createPluginCommandItem(command));
  }, [createPluginCommandItem, getAvailablePluginCommands]);

  return {
    createPluginCommandItem,
    getAvailablePluginCommands,
    openPluginCommandWorkflow,
    pluginCommandItems,
    pluginCommandResultItems,
  };
}
