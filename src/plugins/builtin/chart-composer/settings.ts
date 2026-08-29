import type { ChartResolution, TimeRange } from "../../../components/chart/core/types";
import { CHART_RESOLUTIONS, TIME_RANGES as CHART_RANGES } from "../../../time-series/range";
import type {
  PaneSettingField,
  PaneSettingOption,
  PaneSettingsContext,
  PaneSettingsDef,
} from "../../../types/plugin";
import type {
  ChartPanelSpec,
  ChartSeriesSpec,
  ChartSpec,
  ChartStudySpec,
  SeriesStyle,
} from "../../../time-series/types";
import { isOhlcSeriesStyle } from "../../../time-series/spec";
import {
  applySeriesStyle,
  buildCustomChartPreset,
  buildEmptyChartPreset,
  buildPriceChartPreset,
  chartSeriesLabel,
  formatSeriesExpression,
  getCompatibleSeriesStyles,
  getSelectedBuiltinStudies,
  getSelectedPairStudies,
  setBuiltinStudies,
  setPairStudies,
  type BuiltinStudySelection,
  type PairStudySelection,
} from "./presets";
import {
  CHART_SPEC_SETTING_KEY,
  parseChartSpecOr,
} from "./chart-spec";

export { CHART_RANGES, CHART_RESOLUTIONS };

export const CHART_STUDY_OPTIONS: Array<PaneSettingOption & { value: BuiltinStudySelection }> = [
  { value: "volume", label: "Volume", description: "Volume columns in a lower panel." },
  { value: "sma20", label: "SMA 20", description: "20-bar simple moving average on the primary price series." },
  { value: "sma50", label: "SMA 50", description: "50-bar simple moving average on the primary price series." },
  { value: "sma200", label: "SMA 200", description: "200-bar simple moving average on the primary price series." },
  { value: "ema20", label: "EMA 20", description: "20-bar exponential moving average on the primary price series." },
  { value: "bollinger20", label: "Bollinger 20", description: "20-bar Bollinger Bands at two standard deviations." },
  { value: "rsi14", label: "RSI 14", description: "14-bar Relative Strength Index in a lower panel." },
  { value: "macd", label: "MACD", description: "12/26/9 MACD in a lower panel." },
];

export const CHART_FORMULA_OPTIONS: Array<PaneSettingOption & { value: PairStudySelection }> = [
  { value: "ratio", label: "Ratio", description: "First series divided by the second series." },
  { value: "spread", label: "Spread", description: "First series minus the second series." },
  { value: "correlation", label: "Correlation 20", description: "20-observation rolling return correlation." },
];

export const CHART_SETTING_KEYS = {
  series: "chartSeries",
  indicators: "chartIndicators",
  formulas: "chartFormulas",
  dateWindow: "chartDateWindow",
  range: "chartRange",
  resolution: "chartResolution",
  mode: "chartMode",
} as const;

function fallbackSpec(symbol: string | null | undefined): ChartSpec {
  return symbol ? buildPriceChartPreset(symbol) : buildEmptyChartPreset();
}

function sourceKey(series: ChartSeriesSpec): string {
  return formatSeriesExpression(series).toLowerCase();
}

/**
 * The compact style picker is intentionally scoped to a chart with exactly one
 * authored series. Multi-series styling belongs in the Series editor where the
 * target is explicit, even when all but one series are currently hidden.
 */
export function getChartInlineStyleTarget(spec: ChartSpec): ChartSeriesSpec | null {
  return spec.series.length === 1 ? spec.series[0] ?? null : null;
}

export function getChartInlineStyles(spec: ChartSpec): SeriesStyle[] {
  const target = getChartInlineStyleTarget(spec);
  if (!target) return [];
  const fieldId = target.source.kind === "security" ? target.source.fieldId : "";
  const anotherOhlcSeriesSharesPanel = spec.series.some((series) => (
    series.id !== target.id
    && series.panelId === target.panelId
    && isOhlcSeriesStyle(series.style)
  ));
  return getCompatibleSeriesStyles(fieldId).filter((style) => (
    !anotherOhlcSeriesSharesPanel || !isOhlcSeriesStyle(style)
  ));
}

function managedStudy(study: ChartStudySpec): boolean {
  return study.id.startsWith("builtin:") || study.id.startsWith("pair:");
}

function reconcileBasePanels(
  existing: readonly ChartPanelSpec[],
  authored: readonly ChartPanelSpec[],
  series: readonly ChartSeriesSpec[],
  studies: readonly ChartStudySpec[],
): ChartPanelSpec[] {
  const requiredIds = new Set([
    "main",
    ...series.map((entry) => entry.panelId),
    ...studies.map((entry) => entry.panelId),
  ]);
  const existingById = new Map(existing.map((panel) => [panel.id, panel] as const));
  const authoredById = new Map(authored.map((panel) => [panel.id, panel] as const));
  return [...requiredIds].map((id) => (
    existingById.get(id)
    ?? authoredById.get(id)
    ?? { id }
  ));
}

function replaceChartSeriesFromExpression(
  spec: ChartSpec,
  expression: string,
): ChartSpec {
  const authored = buildCustomChartPreset(expression);
  const existingBySource = new Map<string, ChartSeriesSpec[]>();
  for (const series of spec.series) {
    const key = sourceKey(series);
    existingBySource.set(key, [...(existingBySource.get(key) ?? []), series]);
  }

  const series = authored.series.map((entry) => {
    const matches = existingBySource.get(sourceKey(entry));
    return matches?.shift() ?? entry;
  });
  const seriesIds = new Set(series.map((entry) => entry.id));
  const customStudies = spec.studies.filter((study) => (
    !managedStudy(study)
    && study.inputSeriesIds.every((seriesId) => seriesIds.has(seriesId))
  ));
  const builtinStudies = getSelectedBuiltinStudies(spec);
  const pairStudies = getSelectedPairStudies(spec);
  const panels = reconcileBasePanels(spec.panels, authored.panels, series, customStudies);
  const base: ChartSpec = {
    ...spec,
    series,
    studies: customStudies,
    panels,
  };
  return setPairStudies(setBuiltinStudies(base, builtinStudies), pairStudies);
}

function formatDateWindow(spec: ChartSpec): string {
  const window = spec.viewport.dateWindow;
  return window ? `${window.start} to ${window.end}` : "";
}

function parseDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Use YYYY-MM-DD dates.");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`"${value}" is not a valid date.`);
  }
  return value;
}

function parseDateWindow(value: string): { start: string; end: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})\s*(?:to|through|\.\.|,|–|—)\s*(\d{4}-\d{2}-\d{2})$/i,
  );
  if (!match) {
    throw new Error("Use YYYY-MM-DD to YYYY-MM-DD, or leave blank for the preset range.");
  }
  const start = parseDate(match[1]!);
  const end = parseDate(match[2]!);
  if (start > end) throw new Error("The start date must be before the end date.");
  return { start, end };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  return value;
}

function requireSelection<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T[] {
  if (!Array.isArray(value) || value.some((entry) => (
    typeof entry !== "string" || !allowed.includes(entry as T)
  ))) {
    throw new Error(`Choose valid ${label.toLowerCase()} options.`);
  }
  return value as T[];
}

function cleanDerivedSettings(
  settings: Record<string, unknown>,
  spec: ChartSpec,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...settings,
    [CHART_SPEC_SETTING_KEY]: spec,
  };
  for (const key of Object.values(CHART_SETTING_KEYS)) delete next[key];
  delete next.chartExpression;
  return next;
}

export function applyChartComposerPaneSetting(
  settings: Record<string, unknown>,
  field: PaneSettingField,
  value: unknown,
  context?: Pick<PaneSettingsContext, "activeTicker">,
): Record<string, unknown> {
  const spec = parseChartSpecOr(
    settings[CHART_SPEC_SETTING_KEY],
    fallbackSpec(context?.activeTicker),
  );
  let nextSpec = spec;

  switch (field.key) {
    case CHART_SETTING_KEYS.series:
      nextSpec = replaceChartSeriesFromExpression(spec, requireString(value, "Series"));
      break;
    case CHART_SETTING_KEYS.indicators:
      nextSpec = setBuiltinStudies(
        spec,
        requireSelection(
          value,
          CHART_STUDY_OPTIONS.map((option) => option.value),
          "indicator",
        ),
      );
      break;
    case CHART_SETTING_KEYS.formulas:
      nextSpec = setPairStudies(
        spec,
        requireSelection(
          value,
          CHART_FORMULA_OPTIONS.map((option) => option.value),
          "formula",
        ),
      );
      break;
    case CHART_SETTING_KEYS.dateWindow: {
      const dateWindow = parseDateWindow(requireString(value, "Date window"));
      nextSpec = {
        ...spec,
        viewport: {
          ...spec.viewport,
          dateWindow,
          maxPoints: undefined,
        },
      };
      break;
    }
    case CHART_SETTING_KEYS.range: {
      const range = requireString(value, "Range") as TimeRange;
      if (!CHART_RANGES.includes(range)) throw new Error("Choose a valid chart range.");
      nextSpec = {
        ...spec,
        viewport: {
          ...spec.viewport,
          range,
          dateWindow: undefined,
          maxPoints: undefined,
        },
      };
      break;
    }
    case CHART_SETTING_KEYS.resolution: {
      const resolution = requireString(value, "Resolution") as ChartResolution;
      if (!CHART_RESOLUTIONS.includes(resolution)) throw new Error("Choose a valid chart resolution.");
      nextSpec = { ...spec, viewport: { ...spec.viewport, resolution } };
      break;
    }
    case CHART_SETTING_KEYS.mode: {
      const target = getChartInlineStyleTarget(spec);
      const mode = requireString(value, "Mode") as SeriesStyle;
      if (!target) {
        throw new Error(spec.series.length === 0
          ? "Add a series before choosing a chart style."
          : "Use the Series editor to style a multi-series chart.");
      }
      if (!getChartInlineStyles(spec).includes(mode)) {
        throw new Error(`That chart style is not compatible with ${chartSeriesLabel(target)}.`);
      }
      nextSpec = {
        ...spec,
        series: spec.series.map((series) => (
          series.id === target.id ? applySeriesStyle(series, mode) : series
        )),
      };
      break;
    }
    default:
      return { ...settings, [field.key]: value };
  }

  return cleanDerivedSettings(settings, nextSpec);
}

export function buildChartComposerPaneSettingsDef(
  settings: Record<string, unknown>,
  activeTicker?: string | null,
): PaneSettingsDef {
  const spec = parseChartSpecOr(settings[CHART_SPEC_SETTING_KEY], fallbackSpec(activeTicker));
  const inlineStyleTarget = getChartInlineStyleTarget(spec);
  const modes = getChartInlineStyles(spec);

  return {
    title: "Chart Settings",
    values: {
      [CHART_SETTING_KEYS.series]: spec.series.map(formatSeriesExpression).join(", "),
      [CHART_SETTING_KEYS.indicators]: getSelectedBuiltinStudies(spec),
      [CHART_SETTING_KEYS.formulas]: getSelectedPairStudies(spec),
      [CHART_SETTING_KEYS.dateWindow]: formatDateWindow(spec),
      [CHART_SETTING_KEYS.range]: spec.viewport.range,
      [CHART_SETTING_KEYS.resolution]: spec.viewport.resolution,
      [CHART_SETTING_KEYS.mode]: inlineStyleTarget?.style ?? "",
    },
    fields: [
      {
        key: CHART_SETTING_KEYS.series,
        label: "Series",
        description: "Edit the chart sources. Press S in the pane for guided search and field suggestions.",
        type: "text",
        placeholder: "AAPL:price, MSFT:revenue, FRED:CPIAUCSL",
      },
      {
        key: CHART_SETTING_KEYS.indicators,
        label: "Indicators",
        description: "Choose price studies and lower-panel indicators.",
        type: "multi-select",
        options: CHART_STUDY_OPTIONS,
      },
      {
        key: CHART_SETTING_KEYS.formulas,
        label: "Formulas",
        description: "Compare two chart series with a derived formula.",
        type: "multi-select",
        options: CHART_FORMULA_OPTIONS,
      },
      {
        key: CHART_SETTING_KEYS.dateWindow,
        label: "Date Window",
        description: "Enter YYYY-MM-DD to YYYY-MM-DD. Leave blank to use the preset range.",
        type: "text",
        placeholder: "2025-01-01 to 2026-01-01",
      },
      {
        key: CHART_SETTING_KEYS.range,
        label: "Range",
        description: "Set the preset time range and clear any custom date window.",
        type: "select",
        options: CHART_RANGES.map((range) => ({ value: range, label: range })),
      },
      {
        key: CHART_SETTING_KEYS.resolution,
        label: "Resolution",
        description: "Choose the observation interval, or let the chart select it automatically.",
        type: "select",
        options: CHART_RESOLUTIONS.map((resolution) => ({
          value: resolution,
          label: resolution.toUpperCase(),
        })),
      },
      ...(inlineStyleTarget
        ? [{
          key: CHART_SETTING_KEYS.mode,
          label: `Style (${chartSeriesLabel(inlineStyleTarget)})`,
          description: `Choose how ${chartSeriesLabel(inlineStyleTarget)} is drawn.`,
          type: "select" as const,
          options: modes.map((mode) => ({ value: mode, label: mode.toUpperCase() })),
        }]
        : []),
    ],
    applyValue: applyChartComposerPaneSetting,
  };
}
