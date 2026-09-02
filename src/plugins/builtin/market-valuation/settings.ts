import type { PaneSettingsDef } from "../../../types/plugin";
import type { ValuationRangeId } from "./defs";
import { DEFAULT_INDICATOR_ID, INDICATORS } from "./indicators";

export const VALUATION_DEFAULTS = {
  indicator: DEFAULT_INDICATOR_ID,
  range: "25Y",
} as const satisfies { indicator: string; range: ValuationRangeId };

export const RANGE_OPTIONS = [
  { value: "10Y" as const, label: "10Y" },
  { value: "25Y" as const, label: "25Y" },
  { value: "ALL" as const, label: "All" },
];

export function indicatorOptions(): Array<{ label: string; value: string }> {
  return INDICATORS.map((indicator) => ({ label: indicator.label, value: indicator.id }));
}

export function buildValuationSettingsDef(): PaneSettingsDef {
  return {
    title: "Market Valuation Settings",
    fields: [
      {
        key: "indicator",
        label: "Indicator",
        type: "select",
        options: indicatorOptions(),
      },
      {
        key: "range",
        label: "History",
        type: "select",
        options: RANGE_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
      },
    ],
  };
}
