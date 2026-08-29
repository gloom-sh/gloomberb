import type { PaneSettingsDef } from "../../../types/plugin";
import type { BuffettModeId, BuffettRangeId } from "./model";

export const BUFFETT_DEFAULTS = { mode: "wilshire", range: "10Y" } as const satisfies {
  mode: BuffettModeId;
  range: BuffettRangeId;
};

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
