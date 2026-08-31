import { useEffect, useRef } from "react";
import type { PluginRegistry } from "../../../plugins/registry";
import type { AppState } from "../../../state/app/context";
import type { CommandDef } from "../../../types/plugin";

interface UseCommandBarLaunchRequestOptions {
  activeTickerSymbol: string | null;
  commandBarLaunchRequest: AppState["commandBarLaunchRequest"];
  commandBarOpen: boolean;
  openModeRoute: (
    screen: "ticker-search" | "layout",
    initialQuery?: string,
    payload?: Record<string, unknown>,
  ) => void;
  openPluginCommandWorkflow: (
    command: CommandDef,
    options?: { values?: Record<string, string> },
  ) => void;
  pluginRegistry: PluginRegistry;
}

export function useCommandBarLaunchRequest({
  activeTickerSymbol,
  commandBarLaunchRequest,
  commandBarOpen,
  openModeRoute,
  openPluginCommandWorkflow,
  pluginRegistry,
}: UseCommandBarLaunchRequestOptions) {
  const processedLaunchSequenceRef = useRef<number | null>(null);

  useEffect(() => {
    const launch = commandBarLaunchRequest;
    if (!launch) {
      processedLaunchSequenceRef.current = null;
      return;
    }
    if (!commandBarOpen) return;
    if (processedLaunchSequenceRef.current === launch.sequence) return;
    processedLaunchSequenceRef.current = launch.sequence;

    if (launch.kind === "ticker-search") {
      openModeRoute("ticker-search", launch.query ?? "");
      return;
    }

    const command = pluginRegistry.commands.get(launch.commandId);
    if (!command?.wizard || command.wizard.length === 0) return;
    let values: Record<string, string> | undefined;
    try {
      values = command.shortcutArg?.parse?.("", {
        activeTicker: activeTickerSymbol,
      });
    } catch {
      values = undefined;
    }
    openPluginCommandWorkflow(command, values ? { values } : undefined);
  }, [
    activeTickerSymbol,
    commandBarLaunchRequest,
    commandBarOpen,
    openModeRoute,
    openPluginCommandWorkflow,
    pluginRegistry,
  ]);
}
