import { useCallback, type Dispatch } from "react";
import { getPaneTemplateDisplayLabel } from "../../components/command-bar/pane-templates/items";
import { createPaneTemplateOrThrow } from "../../components/command-bar/workflow/ops";
import { openFormModal } from "../../components/form-modal";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { PluginRegistry } from "../../plugins/registry";
import { PluginOffError, notifyPluginOff } from "../../plugins/plugin-off";
import type { AppAction, AppState } from "../../state/app/context";
import type { PaneBinding, PaneInstanceConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type {
  PaneDef,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
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

/**
 * Whether shared data opens the pane by itself: the template takes it whole
 * (a chart a plugin built), so its settings form would ask for what the data
 * already says. A template that restores shares decides; any other takes data
 * that holds something.
 */
function shareDataOpens(template: Pick<PaneTemplateDef, "publicShare">, shareData: unknown): boolean {
  if (!shareData || typeof shareData !== "object" || Array.isArray(shareData)) return false;
  const restore = template.publicShare?.restore;
  if (!restore) return Object.keys(shareData).length > 0;
  try {
    return restore(shareData as Record<string, unknown>) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether opening a template asks for its settings first, in the same form the
 * command bar opens, which creates the pane when it is sent.
 */
export function templateAsksForSettings(
  template: Pick<PaneTemplateDef, "wizard" | "publicShare">,
  options: PaneTemplateCreateOptions | undefined,
): boolean {
  return !!template.wizard
    && template.wizard.length > 0
    && !options?.values
    && !shareDataOpens(template, options?.shareData)
    && (!options?.arg || template.wizard.some((step) => step.type === "textarea"));
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

    if (templateAsksForSettings(template, options)) {
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
      if (error instanceof PluginOffError) {
        notifyPluginOff(pluginRegistry, error, () => { void createPaneFromTemplate(templateId, options); });
        return;
      }
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
