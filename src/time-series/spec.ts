import type { ChartResolution, TimeRange } from "./range";
import { getChartResolutionLabel } from "./resolution";
import {
  canonicalTimeSeriesFieldId,
  getTimeSeriesField,
  isFundamentalFieldId,
} from "./field-catalog";
import {
  isResolutionFineEnoughForMarketPeriod,
  maximumResolutionForMarketPeriod,
} from "./market-resolution";
import {
  CHART_SPEC_VERSION,
  type ChartPanelSpec,
  type ChartSeriesSource,
  type ChartSeriesSpec,
  type ChartSpec,
  type ChartStudyKind,
  type ChartStudySpec,
  type PanelScale,
  type SeriesAxis,
  type SeriesInterpolation,
  type SeriesPeriod,
  type SeriesStyle,
  type SeriesTimestampMode,
  type SeriesTransform,
  type SecuritySeriesSource,
} from "./types";
import {
  isValidChartCapabilityId,
  isValidChartSeriesId,
} from "../capabilities/chart-series";

const TIME_RANGES = new Set<TimeRange>(["1D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"]);
const RESOLUTIONS = new Set<ChartResolution>(["auto", "1m", "5m", "15m", "30m", "45m", "1h", "1d", "1wk", "1mo"]);
const PERIODS = new Set<SeriesPeriod>(["auto", "daily", "weekly", "monthly", "quarterly", "annual", "ttm"]);
const STYLES = new Set<SeriesStyle>(["line", "area", "step", "columns", "points", "candles", "ohlc", "hlc"]);
const ECONOMIC_STYLES = new Set<SeriesStyle>(["line", "area", "step", "columns", "points"]);
const TRANSFORMS = new Set<SeriesTransform>(["raw", "percent", "index100", "yoy", "qoq", "log"]);
const AXES = new Set<SeriesAxis>(["auto", "left", "right"]);
const SCALES = new Set<PanelScale>(["linear", "log"]);
const STUDIES = new Set<ChartStudyKind>([
  "volume",
  "sma",
  "ema",
  "bollinger",
  "rsi",
  "macd",
  "ratio",
  "spread",
  "correlation",
]);

export function isOhlcSeriesStyle(style: SeriesStyle): boolean {
  return style === "candles" || style === "ohlc" || style === "hlc";
}

export function coerceSeriesTransformForStyle(
  style: SeriesStyle,
  transform: SeriesTransform,
): SeriesTransform {
  return isOhlcSeriesStyle(style) ? "raw" : transform;
}

export function coerceSeriesInterpolationForStyle(
  style: SeriesStyle,
): SeriesInterpolation {
  return style === "step" ? "step-after" : "none";
}

export const MAX_CHART_SERIES = 10;

export const DEFAULT_CHART_SPEC: ChartSpec = Object.freeze({
  version: CHART_SPEC_VERSION,
  viewport: Object.freeze({ range: "1Y", resolution: "auto" }),
  panels: Object.freeze([Object.freeze({ id: "main", height: 1, scale: "linear" })]) as unknown as ChartPanelSpec[],
  series: Object.freeze([]) as unknown as ChartSeriesSpec[],
  studies: Object.freeze([]) as unknown as ChartStudySpec[],
});

export interface ChartSpecIssue {
  path: string;
  code: string;
  message: string;
}

export interface ChartSpecValidationResult {
  valid: boolean;
  errors: ChartSpecIssue[];
  warnings: ChartSpecIssue[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function uniqueId(candidate: unknown, prefix: string, index: number, seen: Set<string>): string {
  const base = nonEmptyString(candidate) ?? `${prefix}-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (seen.has(id)) id = `${base}-${suffix++}`;
  seen.add(id);
  return id;
}

function cloneSpec(spec: ChartSpec): ChartSpec {
  return {
    version: CHART_SPEC_VERSION,
    viewport: {
      ...spec.viewport,
      dateWindow: spec.viewport.dateWindow ? { ...spec.viewport.dateWindow } : undefined,
    },
    panels: spec.panels.map((panel) => ({ ...panel })),
    series: spec.series.map((entry) => ({
      ...entry,
      source: entry.source.kind === "security"
        ? { ...entry.source, instrument: { ...entry.source.instrument } }
        : { ...entry.source },
    })),
    studies: spec.studies.map((study) => ({
      ...study,
      inputSeriesIds: [...study.inputSeriesIds],
      parameters: { ...study.parameters },
    })),
  };
}

function normalizeSource(value: unknown): ChartSeriesSource | null {
  const source = record(value);
  if (!source) return null;
  if (source.kind === "economic") {
    const seriesId = nonEmptyString(source.seriesId);
    if (!seriesId || source.provider !== "fred") return null;
    return { kind: "economic", provider: "fred", seriesId };
  }
  if (source.kind === "capability") {
    const capabilityId = nonEmptyString(source.capabilityId);
    const seriesId = nonEmptyString(source.seriesId);
    if (!capabilityId || !seriesId
      || !isValidChartCapabilityId(capabilityId)
      || !isValidChartSeriesId(seriesId)) return null;
    return { kind: "capability", capabilityId, seriesId };
  }
  if (source.kind !== "security") return null;
  const instrument = record(source.instrument);
  const symbol = nonEmptyString(instrument?.symbol);
  const fieldId = nonEmptyString(source.fieldId);
  if (!instrument || !symbol || !fieldId) return null;
  const period = PERIODS.has(source.period as SeriesPeriod) ? source.period as SeriesPeriod : undefined;
  const timestampMode = source.timestampMode === "period-end" || source.timestampMode === "available-at"
    ? source.timestampMode as SeriesTimestampMode
    : undefined;
  return {
    kind: "security",
    instrument: {
      ...(instrument as ChartSeriesSource & Record<string, unknown>),
      symbol: symbol.toUpperCase(),
    } as unknown as SecuritySeriesSource["instrument"],
    fieldId: canonicalTimeSeriesFieldId(fieldId),
    period,
    ...(timestampMode ? { timestampMode } : {}),
  };
}

function normalizedDateWindow(value: unknown): { start: string; end: string } | undefined {
  const window = record(value);
  const start = nonEmptyString(window?.start);
  const end = nonEmptyString(window?.end);
  if (!start || !end) return undefined;
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) return undefined;
  return { start, end };
}

function normalizePanel(value: unknown, index: number, seen: Set<string>): ChartPanelSpec | null {
  const panel = record(value);
  if (!panel) return null;
  const id = uniqueId(panel.id, "panel", index, seen);
  const height = typeof panel.height === "number" && Number.isFinite(panel.height) && panel.height > 0
    ? Math.min(10, Math.max(0.1, panel.height))
    : undefined;
  return {
    id,
    label: nonEmptyString(panel.label) ?? undefined,
    height,
    scale: SCALES.has(panel.scale as PanelScale) ? panel.scale as PanelScale : "linear",
  };
}

function normalizeSeries(
  value: unknown,
  index: number,
  seen: Set<string>,
  defaultPanelId: string,
): ChartSeriesSpec | null {
  const entry = record(value);
  if (!entry) return null;
  const source = normalizeSource(entry.source);
  if (!source) return null;
  const definition = source.kind === "security" ? getTimeSeriesField(source.fieldId) : undefined;
  const requestedStyle = STYLES.has(entry.style as SeriesStyle) ? entry.style as SeriesStyle : undefined;
  const requestedTransform = TRANSFORMS.has(entry.transform as SeriesTransform)
    ? entry.transform as SeriesTransform
    : undefined;
  const style = definition
    ? requestedStyle && definition.styles.includes(requestedStyle)
      ? requestedStyle
      : definition.defaultStyle
    : source.kind === "economic"
      ? requestedStyle && ECONOMIC_STYLES.has(requestedStyle) ? requestedStyle : "step"
      : requestedStyle ?? "line";
  const transform = definition
    ? requestedTransform && definition.transforms.includes(requestedTransform)
      ? requestedTransform
      : "raw"
    : requestedTransform ?? "raw";
  const normalizedSource = source.kind === "security" && isFundamentalFieldId(source.fieldId)
    ? {
        ...source,
        // V1 specs created before timing became an independent control may not
        // contain a timestamp mode. Preserve their legacy visual semantics once
        // during normalization, then persist the explicit choice.
        timestampMode: source.timestampMode
          ?? (style === "columns" ? "period-end" as const : "available-at" as const),
      }
    : source;
  return {
    id: uniqueId(entry.id, "series", index, seen),
    source: normalizedSource,
    label: nonEmptyString(entry.label) ?? undefined,
    style,
    transform,
    axis: AXES.has(entry.axis as SeriesAxis) ? entry.axis as SeriesAxis : "auto",
    panelId: nonEmptyString(entry.panelId) ?? defaultPanelId,
    interpolation: coerceSeriesInterpolationForStyle(style),
    color: nonEmptyString(entry.color) ?? undefined,
    visible: typeof entry.visible === "boolean" ? entry.visible : true,
  };
}

function normalizeStudy(
  value: unknown,
  index: number,
  seen: Set<string>,
  defaultPanelId: string,
): ChartStudySpec | null {
  const study = record(value);
  if (!study || !STUDIES.has(study.kind as ChartStudyKind)) return null;
  const parameters: Record<string, number> = {};
  const rawParameters = record(study.parameters);
  for (const [key, parameter] of Object.entries(rawParameters ?? {})) {
    if (typeof parameter === "number" && Number.isFinite(parameter)) parameters[key] = parameter;
  }
  return {
    id: uniqueId(study.id, "study", index, seen),
    kind: study.kind as ChartStudyKind,
    inputSeriesIds: Array.isArray(study.inputSeriesIds)
      ? [...new Set(study.inputSeriesIds.map(nonEmptyString).filter((id): id is string => id !== null))]
      : [],
    parameters,
    panelId: nonEmptyString(study.panelId) ?? defaultPanelId,
    axis: AXES.has(study.axis as SeriesAxis) ? study.axis as SeriesAxis : "auto",
    color: nonEmptyString(study.color) ?? undefined,
    visible: typeof study.visible === "boolean" ? study.visible : true,
  };
}

/** Normalizes persisted or user-authored data into the current versioned chart spec. */
export function normalizeChartSpec(value: unknown, fallback: ChartSpec = DEFAULT_CHART_SPEC): ChartSpec {
  const input = record(value);
  if (!input) return cloneSpec(fallback);
  const fallbackCopy = cloneSpec(fallback);
  const viewport = record(input.viewport);
  const panelIds = new Set<string>();
  let panels = (Array.isArray(input.panels) ? input.panels : fallbackCopy.panels)
    .map((panel, index) => normalizePanel(panel, index, panelIds))
    .filter((panel): panel is ChartPanelSpec => panel !== null);
  if (panels.length === 0) panels = [{ id: "main", height: 1, scale: "linear" }];
  const defaultPanelId = panels[0]!.id;

  const seriesIds = new Set<string>();
  const series = (Array.isArray(input.series) ? input.series : fallbackCopy.series)
    .slice(0, MAX_CHART_SERIES)
    .map((entry, index) => normalizeSeries(entry, index, seriesIds, defaultPanelId))
    .filter((entry): entry is ChartSeriesSpec => entry !== null);
  const studyIds = new Set<string>();
  const studies = (Array.isArray(input.studies) ? input.studies : fallbackCopy.studies)
    .map((study, index) => normalizeStudy(study, index, studyIds, defaultPanelId))
    .filter((study): study is ChartStudySpec => study !== null);

  const referencedPanelIds = new Set([
    ...series.map((entry) => entry.panelId),
    ...studies.map((study) => study.panelId),
  ]);
  for (const panelId of referencedPanelIds) {
    if (!panels.some((panel) => panel.id === panelId)) panels.push({ id: panelId, height: 0.35, scale: "linear" });
  }

  return {
    version: CHART_SPEC_VERSION,
    viewport: {
      range: TIME_RANGES.has(viewport?.range as TimeRange)
        ? viewport!.range as TimeRange
        : fallbackCopy.viewport.range,
      resolution: RESOLUTIONS.has(viewport?.resolution as ChartResolution)
        ? viewport!.resolution as ChartResolution
        : fallbackCopy.viewport.resolution,
      dateWindow: normalizedDateWindow(viewport?.dateWindow),
      maxPoints: typeof viewport?.maxPoints === "number"
        && Number.isFinite(viewport.maxPoints)
        && viewport.maxPoints > 0
        ? Math.min(10_000, Math.floor(viewport.maxPoints))
        : undefined,
    },
    panels,
    series,
    studies,
  };
}

function issue(path: string, code: string, message: string): ChartSpecIssue {
  return { path, code, message };
}

function requiredInputCount(kind: ChartStudyKind): number {
  return kind === "ratio" || kind === "spread" || kind === "correlation" ? 2 : 1;
}

/** Validates semantic constraints that normalization cannot safely guess. */
export function validateChartSpec(spec: ChartSpec): ChartSpecValidationResult {
  const errors: ChartSpecIssue[] = [];
  const warnings: ChartSpecIssue[] = [];
  if (spec.version !== CHART_SPEC_VERSION) {
    errors.push(issue("version", "unsupported-version", `Unsupported chart spec version ${String(spec.version)}.`));
  }
  if (!TIME_RANGES.has(spec.viewport.range)) errors.push(issue("viewport.range", "invalid-range", "Invalid date range."));
  if (!RESOLUTIONS.has(spec.viewport.resolution)) {
    errors.push(issue("viewport.resolution", "invalid-resolution", "Invalid chart resolution."));
  }
  if (spec.viewport.dateWindow) {
    const start = Date.parse(spec.viewport.dateWindow.start);
    const end = Date.parse(spec.viewport.dateWindow.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      errors.push(issue("viewport.dateWindow", "invalid-window", "Custom date window must contain valid ordered dates."));
    }
  }
  if (spec.viewport.maxPoints !== undefined
    && (!Number.isInteger(spec.viewport.maxPoints) || spec.viewport.maxPoints <= 0 || spec.viewport.maxPoints > 10_000)) {
    errors.push(issue("viewport.maxPoints", "invalid-max-points", "Latest-observation count must be an integer from 1 to 10000."));
  }
  if (spec.panels.length === 0) errors.push(issue("panels", "missing-panel", "At least one chart panel is required."));
  const panelIds = new Set<string>();
  spec.panels.forEach((panel, index) => {
    if (!panel.id.trim()) errors.push(issue(`panels.${index}.id`, "missing-id", "Panel ID is required."));
    if (panelIds.has(panel.id)) errors.push(issue(`panels.${index}.id`, "duplicate-id", `Duplicate panel ID ${panel.id}.`));
    panelIds.add(panel.id);
    if (panel.height !== undefined && (!Number.isFinite(panel.height) || panel.height <= 0)) {
      errors.push(issue(`panels.${index}.height`, "invalid-height", "Panel height must be positive."));
    }
  });
  if (spec.series.length > MAX_CHART_SERIES) {
    errors.push(issue("series", "too-many-series", `A chart supports at most ${MAX_CHART_SERIES} base series.`));
  }

  const seriesIds = new Set<string>();
  const candleCountByPanel = new Map<string, number>();
  const firstCandleByPanel = new Map<string, string>();
  const unitGroupsByPanel = new Map<string, Set<string>>();
  const panelScaleById = new Map(spec.panels.map((panel) => [panel.id, panel.scale ?? "linear"] as const));
  spec.series.forEach((entry, index) => {
    const path = `series.${index}`;
    if (!entry.id.trim()) errors.push(issue(`${path}.id`, "missing-id", "Series ID is required."));
    if (seriesIds.has(entry.id)) errors.push(issue(`${path}.id`, "duplicate-id", `Duplicate series ID ${entry.id}.`));
    seriesIds.add(entry.id);
    if (!panelIds.has(entry.panelId)) {
      errors.push(issue(`${path}.panelId`, "missing-panel", `Panel ${entry.panelId} does not exist.`));
    }
    if (entry.transform === "log" && panelScaleById.get(entry.panelId) === "log") {
      errors.push(issue(
        `${path}.transform`,
        "double-log",
        "Choose either a log transform or a logarithmic panel scale, not both.",
      ));
    }
    if (entry.source.kind === "security") {
      if (!entry.source.instrument.symbol.trim()) {
        errors.push(issue(`${path}.source.instrument.symbol`, "missing-symbol", "Security symbol is required."));
      }
      const definition = getTimeSeriesField(entry.source.fieldId);
      if (!definition) {
        errors.push(issue(`${path}.source.fieldId`, "unknown-field", `Unknown field ${entry.source.fieldId}.`));
      } else {
        if (definition.sourceKind !== entry.source.kind) {
          errors.push(issue(`${path}.source.fieldId`, "wrong-source", `${definition.label} is not valid for this source.`));
        }
        if (!definition.styles.includes(entry.style)) {
          errors.push(issue(`${path}.style`, "unsupported-style", `${entry.style} is not valid for ${definition.label}.`));
        }
        if (!definition.transforms.includes(entry.transform)) {
          errors.push(issue(`${path}.transform`, "unsupported-transform", `${entry.transform} is not valid for ${definition.label}.`));
        }
        if (entry.transform === "qoq" && entry.source.period === "annual") {
          errors.push(issue(`${path}.transform`, "qoq-annual", "Quarter-over-quarter change requires quarterly or finer data."));
        }
        if (definition.id.startsWith("market.") && entry.source.period === "ttm") {
          errors.push(issue(`${path}.source.period`, "unsupported-period", "TTM is not a valid market-price aggregation period."));
        }
        const marketPeriod = definition.id.startsWith("market.") ? entry.source.period : undefined;
        const maximumMarketResolution = maximumResolutionForMarketPeriod(marketPeriod);
        if (marketPeriod
          && maximumMarketResolution
          && spec.viewport.resolution !== "auto"
          && !isResolutionFineEnoughForMarketPeriod(spec.viewport.resolution, marketPeriod)) {
          const period = marketPeriod.charAt(0).toUpperCase() + marketPeriod.slice(1);
          errors.push(issue(
            `${path}.source.period`,
            "market-period-resolution",
            `${period} market series cannot use the coarser ${getChartResolutionLabel(spec.viewport.resolution)} viewport interval. Choose Auto or ${getChartResolutionLabel(maximumMarketResolution)} (or finer).`,
          ));
        }
        if ((definition.id.startsWith("fundamental.") || definition.id.startsWith("valuation."))
          && (entry.source.period === "daily" || entry.source.period === "weekly" || entry.source.period === "monthly")) {
          errors.push(issue(`${path}.source.period`, "unsupported-period", "Financial fields support automatic, quarterly, annual, or TTM periods."));
        }
        const groups = unitGroupsByPanel.get(entry.panelId) ?? new Set<string>();
        groups.add(entry.transform === "percent" || entry.transform === "yoy" || entry.transform === "qoq"
          ? "percent"
          : entry.transform === "index100"
            ? "index"
            : definition.unitGroup);
        unitGroupsByPanel.set(entry.panelId, groups);
      }
    } else if (entry.source.kind === "economic") {
      if (!entry.source.seriesId.trim()) {
        errors.push(issue(`${path}.source.seriesId`, "missing-series", "Economic series ID is required."));
      }
      if (!ECONOMIC_STYLES.has(entry.style)) {
        errors.push(issue(`${path}.style`, "unsupported-style", `${entry.style} is not valid for an economic scalar series.`));
      }
    } else {
      if (!isValidChartCapabilityId(entry.source.capabilityId)) {
        errors.push(issue(`${path}.source.capabilityId`, "invalid-capability", "Chart series capability ID is invalid."));
      }
      if (!isValidChartSeriesId(entry.source.seriesId)) {
        errors.push(issue(`${path}.source.seriesId`, "invalid-series", "Provider series ID is invalid."));
      }
    }
    if (isOhlcSeriesStyle(entry.style)) {
      const count = (candleCountByPanel.get(entry.panelId) ?? 0) + 1;
      candleCountByPanel.set(entry.panelId, count);
      if (count === 1) {
        firstCandleByPanel.set(
          entry.panelId,
          entry.label?.trim()
            || (entry.source.kind === "security" ? entry.source.instrument.symbol : entry.source.seriesId),
        );
      }
      if (entry.transform !== "raw") {
        errors.push(issue(`${path}.transform`, "transformed-ohlc", "OHLC styles require raw values."));
      }
    }
  });
  for (const [panelId, count] of candleCountByPanel) {
    if (count > 1) {
      // Name the series holding the slot: it is often hidden or drawn as a line
      // for lack of OHLC data, so "this panel already has one" reads as a ghost.
      const panelLabel = spec.panels.find((panel) => panel.id === panelId)?.label ?? panelId;
      const holder = firstCandleByPanel.get(panelId);
      errors.push(issue("series", "multiple-ohlc", holder
        ? `${holder} already uses a candle or OHLC style on ${panelLabel}. Give it another style first.`
        : `Panel ${panelLabel} may contain only one candle or OHLC series.`));
    }
  }
  for (const [panelId, groups] of unitGroupsByPanel) {
    if (groups.size > 2) {
      warnings.push(issue("series", "too-many-unit-groups", `Panel ${panelId} has more than two unit groups; normalize a series or use another panel.`));
    }
  }

  const studyIds = new Set<string>();
  spec.studies.forEach((study, index) => {
    const path = `studies.${index}`;
    if (!study.id.trim()) errors.push(issue(`${path}.id`, "missing-id", "Study ID is required."));
    if (studyIds.has(study.id)) errors.push(issue(`${path}.id`, "duplicate-id", `Duplicate study ID ${study.id}.`));
    studyIds.add(study.id);
    if (!panelIds.has(study.panelId)) {
      errors.push(issue(`${path}.panelId`, "missing-panel", `Panel ${study.panelId} does not exist.`));
    }
    const inputCount = requiredInputCount(study.kind);
    if (study.inputSeriesIds.length !== inputCount) {
      errors.push(issue(`${path}.inputSeriesIds`, "wrong-input-count", `${study.kind} requires ${inputCount} input series.`));
    }
    for (const inputId of study.inputSeriesIds) {
      if (!seriesIds.has(inputId)) {
        errors.push(issue(`${path}.inputSeriesIds`, "missing-input", `Input series ${inputId} does not exist.`));
      }
    }
    for (const [name, value] of Object.entries(study.parameters)) {
      if (!Number.isFinite(value)) errors.push(issue(`${path}.parameters.${name}`, "invalid-parameter", "Study parameters must be finite."));
      if ((name === "period" || name === "fast" || name === "slow" || name === "signal") && value <= 0) {
        errors.push(issue(`${path}.parameters.${name}`, "invalid-period", "Study periods must be positive."));
      }
    }
    if (study.kind === "macd") {
      const fast = study.parameters.fast ?? 12;
      const slow = study.parameters.slow ?? 26;
      if (fast >= slow) errors.push(issue(`${path}.parameters`, "invalid-macd-periods", "MACD fast period must be shorter than slow period."));
    }
  });

  if (spec.series.length === 0) warnings.push(issue("series", "empty-chart", "Chart has no data series."));
  return { valid: errors.length === 0, errors, warnings };
}
