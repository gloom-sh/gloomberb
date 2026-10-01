import type { ChartSpec, ChartStudyKind, ChartStudySpec, ResolvedSeries } from "../../../time-series/types";
import { observationDate } from "../../../time-series/price-comparison";
import { zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";
import { DEFAULT_PROFILE_ROWS, vwapAnchors, withVwapAnchors } from "../../../time-series/studies";
import { reconcilePanels } from "./chart-spec-edit";
import { CHART_FIELD_IDS } from "./series-expression";

const STUDY_DEFAULTS = {
  volume: { kind: "volume", panelId: "volume", parameters: {} },
  sma20: { kind: "sma", panelId: "main", parameters: { period: 20 } },
  sma50: { kind: "sma", panelId: "main", parameters: { period: 50 } },
  sma200: { kind: "sma", panelId: "main", parameters: { period: 200 } },
  ema20: { kind: "ema", panelId: "main", parameters: { period: 20 } },
  bollinger20: { kind: "bollinger", panelId: "main", parameters: { period: 20, stdDev: 2 } },
  vwap: { kind: "vwap", panelId: "main", parameters: { bands: 0 } },
  "anchored-vwap": { kind: "anchored-vwap", panelId: "main", parameters: {} },
  "volume-profile": { kind: "volume-profile", panelId: "main", parameters: { rows: DEFAULT_PROFILE_ROWS } },
  rsi14: { kind: "rsi", panelId: "rsi", parameters: { period: 14 } },
  macd: { kind: "macd", panelId: "macd", parameters: { fast: 12, slow: 26, signal: 9 } },
  atr14: { kind: "atr", panelId: "atr", parameters: { period: 14 } },
  "realized-vol": { kind: "realized-vol", panelId: "realized-vol", parameters: { window: 30, estimator: "close-to-close" } },
} as const satisfies Record<string, {
  kind: Exclude<ChartStudyKind, "ratio" | "spread" | "correlation">;
  panelId: string;
  parameters: ChartStudySpec["parameters"];
}>;

export type BuiltinStudySelection = keyof typeof STUDY_DEFAULTS;

const BUILTIN_STUDY_ID_PREFIX = "builtin:";

export function getSelectedBuiltinStudies(spec: ChartSpec): BuiltinStudySelection[] {
  const selected = new Set(spec.studies.flatMap((study) => {
    if (!study.id.startsWith(BUILTIN_STUDY_ID_PREFIX)) return [];
    const selection = study.id.slice(BUILTIN_STUDY_ID_PREFIX.length).split(":", 1)[0];
    return selection && Object.prototype.hasOwnProperty.call(STUDY_DEFAULTS, selection)
      ? [selection as BuiltinStudySelection]
      : [];
  }));
  return (Object.keys(STUDY_DEFAULTS) as BuiltinStudySelection[]).filter((selection) => selected.has(selection));
}

export function setBuiltinStudies(spec: ChartSpec, selected: readonly BuiltinStudySelection[]): ChartSpec {
  const input = spec.series.find((series) => (
    series.source.kind === "security"
    && (series.source.fieldId === CHART_FIELD_IDS.price || series.source.fieldId === CHART_FIELD_IDS.close)
  ));
  const selectedSet = new Set(selected);
  const customStudies = spec.studies.filter((study) => !study.id.startsWith(BUILTIN_STUDY_ID_PREFIX));
  const studies = input
    ? [
      ...customStudies,
      ...(Object.entries(STUDY_DEFAULTS) as Array<[BuiltinStudySelection, typeof STUDY_DEFAULTS[BuiltinStudySelection]]>)
        .filter(([selection]) => selectedSet.has(selection))
        .map(([selection, defaults]): ChartStudySpec => {
          const id = `${BUILTIN_STUDY_ID_PREFIX}${selection}:${input.id}`;
          const previous = spec.studies.find((study) => study.id === id && study.kind === defaults.kind
            && study.inputSeriesIds.length === 1 && study.inputSeriesIds[0] === input.id);
          if (previous) return { ...previous, inputSeriesIds: [input.id], parameters: { ...previous.parameters } };
          return {
            id,
            kind: defaults.kind,
            inputSeriesIds: [input.id],
            parameters: { ...defaults.parameters },
            panelId: defaults.panelId,
            axis: "auto",
          };
        }),
    ]
    : customStudies;
  return { ...spec, studies, panels: reconcilePanels(spec.panels, spec.series, studies) };
}

/** Builtin studies whose lookback the Indicators dialog lets you change. */
const PERIOD_STUDIES = new Set<BuiltinStudySelection>(["sma20", "sma50", "sma200", "ema20", "bollinger20", "rsi14", "atr14"]);

export const STUDY_PERIOD_MIN = 2;
export const STUDY_PERIOD_MAX = 500;

export function isPeriodStudy(selection: string): selection is BuiltinStudySelection {
  return PERIOD_STUDIES.has(selection as BuiltinStudySelection);
}

function builtinStudy(spec: ChartSpec, selection: BuiltinStudySelection): ChartStudySpec | undefined {
  const prefix = `${BUILTIN_STUDY_ID_PREFIX}${selection}:`;
  return spec.studies.find((study) => study.id.startsWith(prefix));
}

export function defaultStudyPeriod(selection: BuiltinStudySelection): number | null {
  const defaults = STUDY_DEFAULTS[selection].parameters as Record<string, unknown>;
  return typeof defaults.period === "number" ? defaults.period : null;
}

/** The period a builtin study runs with: its own when selected, the default otherwise. */
export function builtinStudyPeriod(spec: ChartSpec, selection: BuiltinStudySelection): number | null {
  const period = builtinStudy(spec, selection)?.parameters.period;
  return typeof period === "number" && Number.isFinite(period) ? period : defaultStudyPeriod(selection);
}

/**
 * Changes the period of a selected builtin study. The study keeps its id, so
 * `setBuiltinStudies` carries the new period through later toggles; an
 * unselected study is left alone.
 */
export function setBuiltinStudyPeriod(
  spec: ChartSpec,
  selection: BuiltinStudySelection,
  period: number,
): ChartSpec {
  if (!isPeriodStudy(selection)) return spec;
  const bounded = Math.round(Math.min(STUDY_PERIOD_MAX, Math.max(STUDY_PERIOD_MIN, period)));
  const target = builtinStudy(spec, selection);
  if (!target) return spec;
  return {
    ...spec,
    studies: spec.studies.map((study) => (
      study.id === target.id ? { ...study, parameters: { ...study.parameters, period: bounded } } : study
    )),
  };
}

/** A whole-number setting a builtin study takes besides a period, with its bounds. */
export const STUDY_NUMBER_SETTINGS = {
  vwap: { key: "bands", min: 0, max: 3 },
  "volume-profile": { key: "rows", min: 4, max: 100 },
} as const satisfies Partial<Record<BuiltinStudySelection, { key: string; min: number; max: number }>>;

export type NumberSettingStudy = keyof typeof STUDY_NUMBER_SETTINGS;

export function isNumberSettingStudy(selection: string): selection is NumberSettingStudy {
  return Object.prototype.hasOwnProperty.call(STUDY_NUMBER_SETTINGS, selection);
}

/** The setting's value: the study's own when selected, the default otherwise. */
export function builtinStudySetting(spec: ChartSpec, selection: NumberSettingStudy): number {
  const { key } = STUDY_NUMBER_SETTINGS[selection];
  const value = builtinStudy(spec, selection)?.parameters[key];
  const fallback = (STUDY_DEFAULTS[selection].parameters as Record<string, number>)[key]!;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function updateBuiltinStudy(
  spec: ChartSpec,
  selection: BuiltinStudySelection,
  update: (parameters: ChartStudySpec["parameters"]) => ChartStudySpec["parameters"],
): ChartSpec {
  const target = builtinStudy(spec, selection);
  if (!target) return spec;
  return {
    ...spec,
    studies: spec.studies.map((study) => (
      study.id === target.id ? { ...study, parameters: update(study.parameters) } : study
    )),
  };
}

export function setBuiltinStudySetting(spec: ChartSpec, selection: NumberSettingStudy, value: number): ChartSpec {
  const { key, min, max } = STUDY_NUMBER_SETTINGS[selection];
  const bounded = Math.round(Math.min(max, Math.max(min, value)));
  return updateBuiltinStudy(spec, selection, (parameters) => ({ ...parameters, [key]: bounded }));
}

/** Anchor times of the chart's anchored VWAP, oldest first. */
export function builtinVwapAnchors(spec: ChartSpec): number[] {
  const study = builtinStudy(spec, "anchored-vwap");
  return study ? vwapAnchors(study) : [];
}

export function setBuiltinVwapAnchors(spec: ChartSpec, anchors: readonly number[]): ChartSpec {
  return updateBuiltinStudy(spec, "anchored-vwap", (parameters) => withVwapAnchors(parameters, anchors));
}

/**
 * An anchor from typed text. `2026-09-30 10:00` is that time at the
 * exchange; `2026-09-30` is the first loaded bar of that session date, or the
 * date itself when it is older than the loaded bars. Null for anything else
 * or a date after the last bar.
 */
export function parseVwapAnchor(text: string, input: ResolvedSeries | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== date) return null;
  if (match[4] !== undefined) {
    const [hour, minute] = [Number(match[4]), Number(match[5])];
    if (hour > 23 || minute > 59) return null;
    return zonedWallClockToUtcMs(input?.timeBasis?.timeZone ?? "UTC", year, month, day, hour, minute, 0);
  }
  const times = (input?.points ?? []).map((point) => point.date.getTime()).sort((left, right) => left - right);
  if (times.length === 0) return null;
  if (date < observationDate(times[0]!, input!)) return Date.UTC(year, month - 1, day);
  return times.find((time) => observationDate(time, input!) >= date) ?? null;
}

export type PairStudySelection = "ratio" | "spread" | "correlation";

const PAIR_STUDY_ID_PREFIX = "pair:";

export function getSelectedPairStudies(spec: ChartSpec): PairStudySelection[] {
  const selected = new Set(spec.studies.flatMap((study) => (
    study.id.startsWith(PAIR_STUDY_ID_PREFIX)
      ? [study.kind as PairStudySelection]
      : []
  )));
  return (["ratio", "spread", "correlation"] as PairStudySelection[])
    .filter((kind) => selected.has(kind));
}

export function setPairStudies(spec: ChartSpec, selected: readonly PairStudySelection[]): ChartSpec {
  const inputs = spec.series.filter((series) => series.visible !== false).slice(0, 2);
  const selectedSet = new Set(selected);
  const pairStudies: ChartStudySpec[] = inputs.length === 2
    ? (["ratio", "spread", "correlation"] as PairStudySelection[])
      .filter((kind) => selectedSet.has(kind))
      .map((kind): ChartStudySpec => {
        const id = `${PAIR_STUDY_ID_PREFIX}${kind}`;
        const inputSeriesIds = inputs.map((series) => series.id);
        const previous = spec.studies.find((study) => study.id === id && study.kind === kind
          && study.inputSeriesIds.length === inputSeriesIds.length
          && study.inputSeriesIds.every((inputId, index) => inputId === inputSeriesIds[index]));
        if (previous) return { ...previous, inputSeriesIds, parameters: { ...previous.parameters } };
        return {
          id,
          kind,
          inputSeriesIds,
          parameters: kind === "spread"
            ? { multiplier: 1 }
            : kind === "correlation"
              ? { period: 20, returns: 1 }
              : {},
          panelId: kind === "correlation" ? "correlation" : "formula",
          axis: "auto",
        };
      })
    : [];
  const studies: ChartStudySpec[] = [
    ...spec.studies.filter((study) => !study.id.startsWith(PAIR_STUDY_ID_PREFIX)),
    ...pairStudies,
  ];
  return { ...spec, studies, panels: reconcilePanels(spec.panels, spec.series, studies) };
}
