import { usePaneSettingValue } from "../../../state/app/context";
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
  description: "Stream quote updates continuously. Turn off to refresh quotes once per minute.",
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

export function useLiveStreamingSetting(): boolean {
  const [enabled] = usePaneSettingValue(LIVE_STREAMING_SETTING_KEY, true);
  return enabled;
}
