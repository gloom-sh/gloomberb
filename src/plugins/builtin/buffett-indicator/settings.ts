import type { PaneSettingsDef } from "../../../types/plugin";
import type { BuffettRangeId } from "./model";

export const BUFFETT_DEFAULTS = { range: "10Y" } as const satisfies {
  range: BuffettRangeId;
};

export function buildBuffettSettingsDef(): PaneSettingsDef {
  return {
    title: "Buffett Indicator Settings",
    fields: [
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
