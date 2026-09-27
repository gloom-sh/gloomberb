import { useCallback, type Dispatch } from "react";
import { getPaneTemplateDisplayLabel } from "../../components/command-bar/pane-templates/items";
import { createPaneTemplateOrThrow } from "../../components/command-bar/workflow/ops";
import { openFormModal } from "../../components/form-modal";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppAction, AppState } from "../../state/app/context";
import type { PaneBinding, PaneInstanceConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type {
  PaneDef,
  PaneTemplateCreateOptions,
  PaneTemplateInstanceConfig,
} from "../../types/plugin";

interface UseAppPaneTemplateRuntimeOptions {
  buildPaneInstance: (paneType: string, options?: {
    title?: string;
    binding?: PaneBinding;
    params?: Record<string, string>;
    settings?: Record<string, unknown>;
    instanceId?: string;
  }) => PaneInstanceConfig | null;
  dataProvider: DataProvider;
  dispatch: Dispatch<AppAction>;
  notify: (body: string, options?: { type?: "info" | "success" | "error" }) => void;
  placePaneInstance: (
    instance: PaneInstanceConfig,
    paneDef: PaneDef,
    options?: PaneTemplateInstanceConfig,
  ) => void;
  pluginRegistry: PluginRegistry;
  stateRef: { current: AppState };
  tickerRepository: AppTickerRepositoryPort;
}

export function useAppPaneTemplateRuntime({
  buildPaneInstance,
  dataProvider,
  dispatch,
  notify,
  placePaneInstance,
  pluginRegistry,
  stateRef,
  tickerRepository,
}: UseAppPaneTemplateRuntimeOptions) {
  const createPaneFromTemplate = useCallback(async (templateId: string, options?: PaneTemplateCreateOptions) => {
    const template = pluginRegistry.paneTemplates.get(templateId);
    if (!template) return;

    // A template that asks for settings asks in the same form the command bar
    // opens, which creates the pane when it is sent.
    const asksForSettings = !!template.wizard
      && template.wizard.length > 0
      && !options?.values
      && (!options?.arg || template.wizard.some((step) => step.type === "textarea"));
    if (asksForSettings) {
      openFormModal({ kind: "pane-template", templateId, arg: options?.arg, options });
      return;
    }

    try {
      await createPaneTemplateOrThrow(templateId, options, {
        dataProvider,
        tickerRepository,
        pluginRegistry,
        dispatch,
        getState: () => stateRef.current,
        buildPaneInstance,
        placePaneInstance,
      });
    } catch (error) {
      notify(
        error instanceof Error ? error.message : `Could not create ${getPaneTemplateDisplayLabel(template).toLowerCase()}.`,
        { type: "info" },
      );
    }
  }, [
    buildPaneInstance,
    dataProvider,
    dispatch,
    notify,
    placePaneInstance,
    pluginRegistry,
    stateRef,
    tickerRepository,
  ]);

  return { createPaneFromTemplate };
}
