import { useCallback } from "react";
import type { AppState } from "../../../state/app/context";
import type {
  PaneTemplateCreateOptions,
  PaneTemplateDef,
} from "../../../types/plugin";
import { normalizeTickerInput } from "../../../tickers/search";
import { debugLog } from "../../../utils/debug-log";
import {
  isCollectionCommand,
} from "../helpers";
import type { ResultItem } from "../list/model";
import {
  buildNonShortcutPaneTemplateItems,
  buildPaneShortcutItems,
  buildPaneTemplateContext,
  buildPaneTemplateItem,
  getAvailablePaneShortcutTemplatesForQuery,
  getAvailablePaneTemplatesForState,
  getPaneTemplateDisplayLabel,
} from "./items";
import type { CommandBarWorkflowRoute } from "../workflow/types";
import {
  resolveTickerInput,
  resolveTickerListInput,
  type SharedWorkflowDeps,
} from "../workflow/ops";
import type { CollectionCommandId } from "../commands/collection";
import type { PluginRegistry } from "../../../plugins/registry";
import {
  buildPaneTemplateWorkflowRoute,
  shouldOpenPaneTemplateConfig,
} from "./workflow-route";

type CloseAllFn = (options?: { revertThemePreview?: boolean }) => void;
type NotifyFn = (body: string, options?: { type?: "info" | "success" | "error" }) => void;
type OpenModeRouteFn = (
  screen: "ticker-search" | "layout",
  initialQuery?: string,
  payload?: Record<string, unknown>,
) => void;
type ExecuteCollectionCommandFn = (
  commandId: CollectionCommandId,
  rawInput?: string,
  explicitTargetId?: string | null,
) => void | Promise<void>;

interface UseCommandBarPaneTemplateActionsOptions {
  activeCollectionId: string | null;
  activeTickerSymbol: string | null;
  buildWorkflowDeps: () => SharedWorkflowDeps;
  closeAll: CloseAllFn;
  config: AppState["config"];
  executeCollectionCommand: ExecuteCollectionCommandFn;
  focusedPaneId: string | null;
  notify: NotifyFn;
  openModeRoute: OpenModeRouteFn;
  openWorkflowRoute: (route: CommandBarWorkflowRoute) => void;
  pluginRegistry: PluginRegistry;
}

const commandBarLog = debugLog.createLogger("command-bar");

export function useCommandBarPaneTemplateActions({
  activeCollectionId,
  activeTickerSymbol,
  buildWorkflowDeps,
  closeAll,
  config,
  executeCollectionCommand,
  focusedPaneId,
  notify,
  openModeRoute,
  openWorkflowRoute,
  pluginRegistry,
}: UseCommandBarPaneTemplateActionsOptions) {
  const getPaneTemplateContext = useCallback(() => buildPaneTemplateContext({
    activeCollectionId,
    activeTicker: activeTickerSymbol,
    config,
    focusedPaneId,
  }), [activeCollectionId, activeTickerSymbol, config, focusedPaneId]);

  const openPaneTemplateWorkflow = useCallback((template: PaneTemplateDef, options?: { arg?: string }) => {
    openWorkflowRoute(buildPaneTemplateWorkflowRoute({
      activeTicker: activeTickerSymbol,
      arg: options?.arg,
      template,
    }));
  }, [activeTickerSymbol, openWorkflowRoute]);

  const openPaneTemplateDirect = useCallback(async (
    template: PaneTemplateDef,
    createOptions?: PaneTemplateCreateOptions,
  ) => {
    try {
      await pluginRegistry.createPaneFromTemplateAsyncFn(template.id, createOptions);
      closeAll({ revertThemePreview: false });
    } catch (error) {
      const displayLabel = getPaneTemplateDisplayLabel(template);
      notify(
        error instanceof Error ? error.message : `Could not create ${displayLabel.toLowerCase()}.`,
        { type: "error" },
      );
    }
  }, [closeAll, notify, pluginRegistry]);

  const runPaneTemplateShortcut = useCallback(async (
    template: PaneTemplateDef,
    rawArg?: string,
  ) => {
    const trimmedArg = rawArg?.trim() || "";
    const argKind = template.shortcut?.argKind ?? template.shortcut?.argPlaceholder;
    if (argKind === "ticker") {
      if (!trimmedArg && template.shortcut?.argOptional) {
        await openPaneTemplateDirect(template);
        return;
      }
      const resolvedTicker = await resolveTickerInput(
        trimmedArg || undefined,
        activeTickerSymbol,
        activeCollectionId,
        buildWorkflowDeps(),
      );
      if (!resolvedTicker) {
        openModeRoute("ticker-search", trimmedArg, {
          action: "pane-template",
          templateId: template.id,
        });
        return;
      }
      await openPaneTemplateDirect(template, {
        arg: resolvedTicker.symbol,
        symbol: resolvedTicker.symbol,
        ticker: resolvedTicker.ticker,
      });
      return;
    }

    if (argKind === "ticker-list") {
      const trimmedList = trimmedArg || normalizeTickerInput(activeTickerSymbol, undefined) || "";
      if (!trimmedList || /[,\n]\s*$/.test(trimmedList)) {
        openPaneTemplateWorkflow(template, { arg: trimmedArg });
        return;
      }
      try {
        const symbols = await resolveTickerListInput(
          trimmedList,
          activeCollectionId,
          buildWorkflowDeps(),
        );
        const createOptions = {
          arg: trimmedList,
          symbols,
        };
        if (template.canCreate && !template.canCreate(getPaneTemplateContext(), createOptions)) {
          openPaneTemplateWorkflow(template, { arg: trimmedArg });
          return;
        }
        await openPaneTemplateDirect(template, createOptions);
      } catch {
        openPaneTemplateWorkflow(template, { arg: trimmedArg });
      }
      return;
    }

    if (shouldOpenPaneTemplateConfig(template, trimmedArg)) {
      openPaneTemplateWorkflow(template, { arg: trimmedArg });
      return;
    }
    await openPaneTemplateDirect(template, trimmedArg ? { arg: trimmedArg } : undefined);
  }, [
    activeCollectionId,
    activeTickerSymbol,
    buildWorkflowDeps,
    getPaneTemplateContext,
    openModeRoute,
    openPaneTemplateDirect,
    openPaneTemplateWorkflow,
  ]);

  const adaptTickerSearchRouteResult = useCallback((
    item: ResultItem,
    routePayload: Record<string, unknown> | undefined,
  ): ResultItem => {
    const routeAction = String(routePayload?.action ?? "");
    if (routeAction === "pane-template") {
      const templateId = String(routePayload?.templateId ?? "");
      const template = pluginRegistry.paneTemplates.get(templateId);
      if (!template) return item;
      return {
        ...item,
        action: () => { void runPaneTemplateShortcut(template, item.label); },
      };
    }
    if (routeAction === "collection-command") {
      const commandId = String(routePayload?.commandId ?? "");
      if (!isCollectionCommand(commandId)) return item;
      return {
        ...item,
        action: () => { void executeCollectionCommand(commandId, item.label); },
      };
    }
    return item;
  }, [executeCollectionCommand, pluginRegistry.paneTemplates, runPaneTemplateShortcut]);

  const getAvailablePaneTemplates = useCallback((
    options?: PaneTemplateCreateOptions,
    availability?: { includePromptableTickerTemplates?: boolean },
  ): PaneTemplateDef[] => {
    return getAvailablePaneTemplatesForState({
      context: getPaneTemplateContext(),
      createOptions: options,
      disabledPlugins: config.disabledPlugins || [],
      includePromptableTickerTemplates: availability?.includePromptableTickerTemplates,
      logError: (message, details) => commandBarLog.error(message, details),
      pluginRegistry,
    });
  }, [config.disabledPlugins, getPaneTemplateContext, pluginRegistry]);

  const getAvailablePaneShortcutTemplates = useCallback((query: string): PaneTemplateDef[] => {
    return getAvailablePaneShortcutTemplatesForQuery({
      context: getPaneTemplateContext(),
      disabledPlugins: config.disabledPlugins || [],
      logError: (message, details) => commandBarLog.error(message, details),
      pluginRegistry,
      query,
    });
  }, [config.disabledPlugins, getPaneTemplateContext, pluginRegistry]);

  const createPaneTemplateItem = useCallback((
    template: PaneTemplateDef,
    options?: {
      category?: string;
      createOptions?: PaneTemplateCreateOptions;
      showShortcut?: boolean;
      shortcutExecution?: boolean;
    },
  ): ResultItem => buildPaneTemplateItem({
    category: options?.category,
    createOptions: options?.createOptions,
    openPaneTemplateDirect,
    openPaneTemplateWorkflow,
    pluginRegistry,
    runPaneTemplateShortcut,
    shortcutExecution: options?.shortcutExecution,
    shouldOpenTemplateConfig: shouldOpenPaneTemplateConfig,
    showShortcut: options?.showShortcut,
    template,
  }), [
    openPaneTemplateDirect,
    openPaneTemplateWorkflow,
    pluginRegistry,
    runPaneTemplateShortcut,
  ]);

  const paneShortcutItems = useCallback((options?: {
    filterQuery?: string;
    createOptions?: PaneTemplateCreateOptions;
    includePromptableTickerTemplates?: boolean;
  }): ResultItem[] => buildPaneShortcutItems({
    createItem: createPaneTemplateItem,
    createOptions: options?.createOptions,
    filterQuery: options?.filterQuery,
    templates: getAvailablePaneTemplates(options?.createOptions, {
      includePromptableTickerTemplates: options?.includePromptableTickerTemplates,
    }),
  }), [createPaneTemplateItem, getAvailablePaneTemplates]);

  const nonShortcutPaneTemplateItems = useCallback((filterQuery?: string): ResultItem[] => {
    return buildNonShortcutPaneTemplateItems({
      createItem: createPaneTemplateItem,
      filterQuery,
      templates: getAvailablePaneTemplates(),
    });
  }, [createPaneTemplateItem, getAvailablePaneTemplates]);

  return {
    adaptTickerSearchRouteResult,
    createPaneTemplateItem,
    getAvailablePaneShortcutTemplates,
    getAvailablePaneTemplates,
    nonShortcutPaneTemplateItems,
    openPaneTemplateWorkflow,
    paneShortcutItems,
  };
}
