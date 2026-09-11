import type { PaneRuntimeState } from "../../core/state/app/state";
import {
  resolveCollectionForPane,
  resolveTickerForPane,
} from "../../core/state/app/state";
import { getPaneSettings, isPaneLocked, PANE_LOCK_SETTING_KEY } from "../../pane-settings";
import type { AppConfig, LayoutConfig, PaneInstanceConfig } from "../../types/config";
import type {
  PaneDef,
  PaneQuickSettingDef,
  PaneSettingField,
  PaneSettingsContext,
  PaneSettingsDef,
} from "../../types/plugin";
import {
  exportPaneTableCsv,
  hasPaneTableExporter,
} from "../../state/pane-table-export-registry";

export interface ResolvedRegistryPaneSettings {
  paneId: string;
  pluginId?: string;
  pane: PaneInstanceConfig;
  paneDef: PaneDef;
  settingsDef: PaneSettingsDef;
  rawSettings: Record<string, unknown>;
  context: PaneSettingsContext;
}

export interface ResolvedRegistryPaneQuickSetting extends PaneQuickSettingDef {
  label: string;
  description?: string;
  value: boolean;
  field: PaneSettingField & { type: "toggle" };
}

export function resolveRegistryPaneQuickSettings(
  resolved: ResolvedRegistryPaneSettings | null,
): ResolvedRegistryPaneQuickSetting[] {
  if (!resolved?.paneDef.quickSettings?.length) return [];

  return resolved.paneDef.quickSettings.flatMap((quickSetting) => {
    const field = resolved.settingsDef.fields.find((candidate) => (
      candidate.key === quickSetting.key && candidate.type === "toggle"
    ));
    if (!field || field.type !== "toggle") return [];
    return [{
      ...quickSetting,
      label: quickSetting.label ?? field.label,
      description: field.description,
      value: resolved.context.settings[quickSetting.key] === true,
      field,
    }];
  });
}

export function resolveRegistryPaneSettings({
  config,
  getConfigState,
  getPaneRuntimeState,
  layout,
  paneDefs,
  paneOwners,
  resolvePaneTarget,
  requestedPaneId,
}: {
  config: AppConfig;
  getConfigState: <T = unknown>(pluginId: string, key: string) => T | null;
  getPaneRuntimeState: (paneId: string) => PaneRuntimeState | null;
  layout: LayoutConfig;
  paneDefs: ReadonlyMap<string, PaneDef>;
  paneOwners: ReadonlyMap<string, string>;
  resolvePaneTarget: (paneId: string) => string | undefined;
  requestedPaneId: string;
}): ResolvedRegistryPaneSettings | null {
  const targetPaneId = resolvePaneTarget(requestedPaneId);
  if (!targetPaneId) return null;

  const pane = layout.instances.find((instance) => instance.instanceId === targetPaneId);
  if (!pane) return null;

  const paneDef = paneDefs.get(pane.paneId);
  if (!paneDef) return null;

  const pluginId = paneOwners.get(pane.paneId);
  const paneSettings = getPaneSettings(pane);
  const paneStateMap = Object.fromEntries(
    layout.instances.map((instance) => [instance.instanceId, getPaneRuntimeState(instance.instanceId) ?? {}]),
  );
  const paneState = paneStateMap[targetPaneId] ?? {};
  const stateView = {
    config,
    paneState: paneStateMap,
  } as any;
  const context: PaneSettingsContext = {
    config,
    layout,
    paneId: targetPaneId,
    paneType: pane.paneId,
    pane,
    settings: paneSettings,
    paneState,
    activeTicker: resolveTickerForPane(stateView, targetPaneId),
    activeCollectionId: resolveCollectionForPane(stateView, targetPaneId),
  };
  const baseSettingsDef = typeof paneDef.settings === "function"
    ? paneDef.settings(context)
    : paneDef.settings;
  const settingsDef: PaneSettingsDef = {
    ...(baseSettingsDef ?? {}),
    fields: [
      ...(baseSettingsDef?.fields ?? []),
      ...(paneDef.tableExport
        ? [{
          key: "tableExport.csv",
          label: "Export CSV",
          description: "Export the current table as an Excel-compatible CSV file.",
          type: "action",
          actionId: "table.export-csv",
          actionLabel: "Export",
          disabled: !hasPaneTableExporter(targetPaneId),
          action: (actionContext) => exportPaneTableCsv(
            targetPaneId,
            pane.title ?? paneDef.name,
            actionContext.notify,
          ),
        } satisfies PaneSettingField]
        : []),
      {
        key: PANE_LOCK_SETTING_KEY,
        label: "Lock Pane",
        description: "Keep this pane in the layout when the close shortcut is pressed.",
        type: "toggle",
      },
    ],
  };

  const rawSettings = { ...paneSettings };
  const resolvedSettings: Record<string, unknown> = {
    ...paneSettings,
    ...(settingsDef.values ?? {}),
    [PANE_LOCK_SETTING_KEY]: isPaneLocked(pane),
  };
  if (pluginId) {
    for (const field of settingsDef.fields) {
      if (field.type === "action" || field.storage !== "plugin") continue;
      const configValue = getConfigState(pluginId, field.key);
      if (configValue === null) {
        delete resolvedSettings[field.key];
      } else {
        resolvedSettings[field.key] = configValue;
      }
    }
  }
  context.settings = resolvedSettings;

  return {
    paneId: targetPaneId,
    pluginId,
    pane,
    paneDef,
    settingsDef,
    rawSettings,
    context,
  };
}
