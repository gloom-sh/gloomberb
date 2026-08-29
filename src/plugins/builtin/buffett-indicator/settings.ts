import type { PaneSettingsDef } from "../../../types/plugin";
import type { BuffettModeId, BuffettRangeId } from "./model";

export const BUFFETT_DEFAULTS = { mode: "wilshire", range: "10Y" } as const satisfies {
  mode: BuffettModeId;
  range: BuffettRangeId;
};

const MODE_IDS = ["wilshire", "z1"] as const satisfies readonly BuffettModeId[];
const RANGE_IDS = ["10Y", "25Y", "ALL"] as const satisfies readonly BuffettRangeId[];

function isBuffettModeId(value: unknown): value is BuffettModeId {
  return MODE_IDS.includes(value as BuffettModeId);
}

function isBuffettRangeId(value: unknown): value is BuffettRangeId {
  return RANGE_IDS.includes(value as BuffettRangeId);
}

export function getBuffettPaneSettings(
  settings: Record<string, unknown> | undefined,
): { mode: BuffettModeId; range: BuffettRangeId } {
  return {
    mode: isBuffettModeId(settings?.mode) ? settings.mode : BUFFETT_DEFAULTS.mode,
    range: isBuffettRangeId(settings?.range) ? settings.range : BUFFETT_DEFAULTS.range,
  };
}

export function buildBuffettSettingsDef(): PaneSettingsDef {
  return {
    title: "Buffett Indicator Settings",
    fields: [
      {
        key: "mode",
        label: "Numerator",
        type: "select",
        options: [
          { value: "wilshire", label: "Wilshire 5000 (daily)" },
          { value: "z1", label: "Z.1 corporate equities (quarterly)" },
        ],
      },
      {
        key: "range",
        label: "History",
        type: "select",
        options: [
          { value: "10Y", label: "10Y" },
          { value: "25Y", label: "25Y" },
          { value: "ALL", label: "All" },
        ],
      },
    ],
  };
}
