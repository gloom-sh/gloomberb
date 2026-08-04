import { useAppSelector, usePaneInstanceId } from "../../../state/app/context";
import { findPaneInstance, type LayoutConfig } from "../../../types/config";
import type {
  PaneQuickSettingDef,
  PaneSettingField,
  PaneSettingsDef,
} from "../../../types/plugin";

export const LIVE_STREAMING_SETTING_KEY = "liveStreaming";

export const LIVE_STREAMING_QUICK_SETTING: PaneQuickSettingDef = {
  type: "toggle",
  key: LIVE_STREAMING_SETTING_KEY,
  icon: "zap",
};

export const LIVE_STREAMING_SETTING_FIELD: PaneSettingField = {
  type: "toggle",
  key: LIVE_STREAMING_SETTING_KEY,
  label: "Live streaming",
  description: "Stream quote updates continuously. Turn off to refresh quotes once per minute. Follow panes inherit their source pane's setting.",
};

export function withLiveStreamingSetting(
  settingsDef: PaneSettingsDef,
  settings: Record<string, unknown> | undefined,
): PaneSettingsDef {
  return {
    ...settingsDef,
    values: {
      ...settingsDef.values,
      [LIVE_STREAMING_SETTING_KEY]: settings?.[LIVE_STREAMING_SETTING_KEY] !== false,
    },
    fields: [
      ...settingsDef.fields.filter((field) => field.key !== LIVE_STREAMING_SETTING_KEY),
      LIVE_STREAMING_SETTING_FIELD,
    ],
  };
}

export function resolveLiveStreamingSetting(
  layout: LayoutConfig,
  paneId: string,
  seen = new Set<string>(),
): boolean {
  if (seen.has(paneId)) return false;

  const pane = findPaneInstance(layout, paneId);
  if (!pane) return true;
  if (pane.settings?.[LIVE_STREAMING_SETTING_KEY] === false) return false;
  if (pane.binding?.kind !== "follow") return true;

  seen.add(paneId);
  return resolveLiveStreamingSetting(layout, pane.binding.sourceInstanceId, seen);
}

export function useLiveStreamingSetting(): boolean {
  const paneId = usePaneInstanceId();
  return useAppSelector((state) => resolveLiveStreamingSetting(state.config.layout, paneId));
}
