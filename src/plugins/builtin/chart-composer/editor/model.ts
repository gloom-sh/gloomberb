import { isFundamentalFieldId } from "../../../../time-series/field-catalog";
import type {
  ChartSeriesSpec,
  ChartSpec,
  PanelScale,
  SeriesAxis,
  SeriesPeriod,
  SeriesStyle,
  SeriesTimestampMode,
  SeriesTransform,
} from "../../../../time-series/types";
import { canToggleChartSeries, MAX_CHART_COMPOSER_SERIES } from "../chart-spec";
import {
  defaultFinancialTimestampMode,
  getCompatibleSeriesStyles,
  getCompatibleSeriesTransforms,
} from "../presets";

export type SeriesEditorFieldId =
  | "style"
  | "transform"
  | "axis"
  | "visibility"
  | "panel"
  | "scale"
  | "period"
  | "timing";

export type SeriesEditorFocus = "add" | "series" | "source" | SeriesEditorFieldId;

export interface SeriesEditorOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SeriesEditorFieldModel {
  id: SeriesEditorFieldId;
  label: string;
  kind: "select" | "visibility" | "panel";
  value: string;
  options: SeriesEditorOption[];
  onChange(value: string): void;
  onAddPanel?: () => void;
}

export interface SeriesEditorActionModel {
  id: "add" | "remove" | "move-up" | "move-down" | "cancel" | "save";
  label: string;
  group: "series" | "confirm";
  variant?: "danger" | "ghost" | "primary";
  shortcut?: string;
  disabled?: boolean;
  onPress(): void;
}

const AXES: SeriesAxis[] = ["auto", "left", "right"];
const MARKET_PERIODS: SeriesPeriod[] = ["auto", "daily", "weekly", "monthly", "quarterly", "annual"];
const FINANCIAL_PERIODS: SeriesPeriod[] = ["auto", "quarterly", "annual", "ttm"];
const TIMING_OPTIONS: Array<{ value: SeriesTimestampMode; label: string }> = [
  { value: "available-at", label: "Available Date" },
  { value: "period-end", label: "Period End" },
];

export function titleCaseSeriesEditorValue(value: string): string {
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function seriesFieldId(series: ChartSeriesSpec): string {
  return series.source.kind === "security" ? series.source.fieldId : series.source.seriesId;
}

function compatiblePeriods(series: ChartSeriesSpec): SeriesPeriod[] {
  if (series.source.kind !== "security") return [];
  return series.source.fieldId.startsWith("market.") ? MARKET_PERIODS : FINANCIAL_PERIODS;
}

export function supportsSeriesTimestampMode(series: ChartSeriesSpec | null): boolean {
  return !!series
    && series.source.kind === "security"
    && isFundamentalFieldId(series.source.fieldId);
}

export function getSeriesEditorFieldIds(selected: ChartSeriesSpec | null): SeriesEditorFieldId[] {
  if (!selected) return [];
  return [
    "style",
    "transform",
    "axis",
    "visibility",
    "panel",
    "scale",
    ...(selected.source.kind === "security" ? ["period" as const] : []),
    ...(supportsSeriesTimestampMode(selected) ? ["timing" as const] : []),
  ];
}

export function getSeriesTimestampMode(series: ChartSeriesSpec): SeriesTimestampMode {
  return series.source.kind === "security"
    ? series.source.timestampMode
      ?? defaultFinancialTimestampMode(series.source.fieldId)
      ?? "available-at"
    : "available-at";
}

export interface SeriesEditorFieldHandlers {
  setStyle(value: SeriesStyle): void;
  setTransform(value: SeriesTransform): void;
  setAxis(value: SeriesAxis): void;
  setVisibility(visible: boolean): void;
  setPanel(panelId: string): void;
  addPanel(): void;
  setScale(scale: PanelScale): void;
  setPeriod(period: SeriesPeriod): void;
  setTimestampMode(mode: SeriesTimestampMode): void;
}

export function buildSeriesEditorFields({
  draft,
  selected,
  handlers,
}: {
  draft: ChartSpec;
  selected: ChartSeriesSpec | null;
  handlers: SeriesEditorFieldHandlers;
}): SeriesEditorFieldModel[] {
  if (!selected) return [];
  const fieldId = seriesFieldId(selected);
  const selectedPanel = draft.panels.find((panel) => panel.id === selected.panelId);
  const fields: SeriesEditorFieldModel[] = [
    {
      id: "style",
      label: "Style",
      kind: "select",
      value: selected.style,
      options: getCompatibleSeriesStyles(fieldId).map((value) => ({
        value,
        label: titleCaseSeriesEditorValue(value),
      })),
      onChange: (value) => handlers.setStyle(value as SeriesStyle),
    },
    {
      id: "transform",
      label: "Transform",
      kind: "select",
      value: selected.transform,
      options: getCompatibleSeriesTransforms(fieldId).map((value) => ({
        value,
        label: value === "index100" ? "Index 100" : value.toUpperCase(),
      })),
      onChange: (value) => handlers.setTransform(value as SeriesTransform),
    },
    {
      id: "axis",
      label: "Axis",
      kind: "select",
      value: selected.axis,
      options: AXES.map((value) => ({ value, label: titleCaseSeriesEditorValue(value) })),
      onChange: (value) => handlers.setAxis(value as SeriesAxis),
    },
    {
      id: "visibility",
      label: "Visibility",
      kind: "visibility",
      value: selected.visible === false ? "hidden" : "shown",
      options: [
        { value: "shown", label: "Shown" },
        {
          value: "hidden",
          label: "Hidden",
          disabled: selected.visible !== false && !canToggleChartSeries(draft, selected.id),
        },
      ],
      onChange: (value) => handlers.setVisibility(value !== "hidden"),
    },
    {
      id: "panel",
      label: "Panel",
      kind: "panel",
      value: selected.panelId,
      options: draft.panels.map((panel) => ({
        value: panel.id,
        label: panel.label ?? titleCaseSeriesEditorValue(panel.id),
      })),
      onChange: handlers.setPanel,
      onAddPanel: handlers.addPanel,
    },
    {
      id: "scale",
      label: `Scale (${selectedPanel?.label ?? selected.panelId})`,
      kind: "select",
      value: selectedPanel?.scale ?? "linear",
      options: [
        { value: "linear", label: "Linear" },
        { value: "log", label: "Log" },
      ],
      onChange: (value) => handlers.setScale(value as PanelScale),
    },
    ...(selected.source.kind === "security" ? [{
      id: "period" as const,
      label: "Period",
      kind: "select" as const,
      value: selected.source.period ?? "auto",
      options: compatiblePeriods(selected).map((value) => ({
        value,
        label: value === "ttm" ? "TTM" : titleCaseSeriesEditorValue(value),
      })),
      onChange: (value: string) => handlers.setPeriod(value as SeriesPeriod),
    }] : []),
    ...(supportsSeriesTimestampMode(selected) ? [{
      id: "timing" as const,
      label: "Timing",
      kind: "select" as const,
      value: getSeriesTimestampMode(selected),
      options: TIMING_OPTIONS,
      onChange: (value: string) => handlers.setTimestampMode(value as SeriesTimestampMode),
    }] : []),
  ];
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  return getSeriesEditorFieldIds(selected).map((id) => fieldsById.get(id)!);
}

export interface SeriesEditorActionHandlers {
  add(): void;
  remove(): void;
  moveUp(): void;
  moveDown(): void;
  cancel(): void;
  save(): void;
}

export function buildSeriesEditorActions({
  draft,
  selected,
  selectedIndex,
  handlers,
}: {
  draft: ChartSpec;
  selected: ChartSeriesSpec | null;
  selectedIndex: number;
  handlers: SeriesEditorActionHandlers;
}): SeriesEditorActionModel[] {
  return [
    {
      id: "add",
      label: "Add Series",
      group: "series",
      shortcut: "A",
      disabled: draft.series.length >= MAX_CHART_COMPOSER_SERIES,
      onPress: handlers.add,
    },
    {
      id: "remove",
      label: "Remove",
      group: "series",
      variant: "danger",
      shortcut: "D",
      disabled: !selected || draft.series.length <= 1,
      onPress: handlers.remove,
    },
    {
      id: "move-up",
      label: "Move Up",
      group: "series",
      disabled: selectedIndex <= 0,
      onPress: handlers.moveUp,
    },
    {
      id: "move-down",
      label: "Move Down",
      group: "series",
      disabled: selectedIndex < 0 || selectedIndex >= draft.series.length - 1,
      onPress: handlers.moveDown,
    },
    {
      id: "cancel",
      label: "Cancel",
      group: "confirm",
      variant: "ghost",
      onPress: handlers.cancel,
    },
    {
      id: "save",
      label: "Save",
      group: "confirm",
      variant: "primary",
      onPress: handlers.save,
    },
  ];
}
