import { FINANCIAL_VINTAGE_NOTICE, SEC_EPS_BASIS_NOTICE } from "../../../utils/financial-statements";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useUiCapabilities, useUiHost } from "../../../ui";
import {
  ChoiceDialog,
  EmptyState,
  QueryBar,
  usePaneFooter,
  usePaneNoticeFooter,
  type PaneFooterPressEvent,
} from "../../../components";
import {
  MultiSelectDialogButton,
  type MultiSelectDialogButtonHandle,
} from "../../../components/ui";
import { CompositeChart } from "../../../components/chart/composite";
import type { PaneProps, TickerResearchTabProps } from "../../../types/plugin";
import type { ChartResolution, TimeRange } from "../../../components/chart/core/types";
import type { ChartSpec, ResolvedSeries } from "../../../time-series/types";
import {
  getSupportedChartResolutionsForViewport,
  type ManualChartResolution,
} from "../../../time-series/resolution";
import { useResolvedChartSpec } from "../../../time-series/hooks";
import { LIVE_CHART_TERMINAL_FRAME_MS } from "../../../time-series/live-quotes";
import { FORWARD_VALUATION_BASIS_NOTICES } from "../../../time-series/forward-valuation";
import { chartSeriesSourceKey } from "../../../capabilities";
import { useShortcut } from "../../../react/input";
import { useDialog, useDialogState, type PromptContext } from "../../../ui/dialog";
import {
  useAppDispatch,
  useAppSelector,
  usePaneInstance,
  usePaneInstanceId,
  usePaneSettingValue,
  usePaneTicker,
  useUpdatePaneSettings,
  type AppState,
} from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { publicTickerKey, resolveExchangeTimeZone } from "../../../utils/exchanges";
import { isMarketFieldId } from "../../../time-series/field-catalog";
import { CHART_COMPOSER_PANE_ID } from "../../../types/config";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { SeriesEditorDialog } from "./editor";
import { chartComposerSemanticMetadata } from "./semantic";
import {
  canToggleChartSeries,
  CHART_INTERACTION_VIEWPORT_SETTING_KEY,
  CHART_SPEC_SETTING_KEY,
  parseChartInteractionViewport,
  parseChartSpecOr,
  projectVisibleChartSeries,
  toggleChartSeries,
} from "./chart-spec";
import {
  buildEmptyChartPreset,
  buildPriceChartPreset,
  chartSeriesLabel,
  defaultFinancialTimestampMode,
  getSelectedBuiltinStudies,
  getSelectedPairStudies,
  setBuiltinStudies,
  setPairStudies,
  rebindResearchChartSpec,
  type BuiltinStudySelection,
  type PairStudySelection,
} from "./presets";
import type { ChartInteractionViewport } from "./chart-spec";
import {
  CHART_FORMULA_OPTIONS,
  CHART_RANGES as RANGES,
  CHART_RESOLUTIONS as RESOLUTIONS,
  CHART_STUDY_OPTIONS,
} from "./settings";
import { resolveChartComposerShortcut } from "./shortcuts";
import { describeChartResolution, formatChartDateWindow, formatChartResolution } from "./viewport-labels";
import { ChartSeriesQuickAdd } from "./quick-add";
import { useLiveStreamingSetting } from "../shared/live-streaming";
import { usePluginAppActions } from "../../runtime";
import { isPlainKey } from "../../../utils/keyboard";
import { resolveInstrumentForPane } from "../../../core/state/app/instrument";
import { CHART_FOLLOW_SERIES_SETTING_KEY, rebindFollowChartSpec, resolveFollowSeriesIds } from "./follow-binding";
import type { InstrumentRef } from "../../../market-data/request-types";

const RANGE_OPTIONS = RANGES.map((range, index) => ({ label: range, value: range, hint: String(index + 1) }));
const AUTO_VIEWPORT_DEBOUNCE_MS = 350;
/**
 * Drawings persist into pane settings on a short debounce after the pointer
 * settles. A share reads those settings, so it waits at least that long for a
 * stroke finished a moment before the key press.
 */
const SHARE_SETTLE_DELAY_MS = 450;
/** Bar pitch AUTO aims for; the coarser neighbour wins ties so bars stay readable. */
const AUTO_RESOLUTION_BAR_PIXELS = 7;
const MINIMUM_AUTO_RESOLUTION_POINTS = 60;

interface RuntimeChartViewport {
  start: Date;
  end: Date;
}

interface RuntimeChartViewportState {
  key: string;
  adaptiveViewport: RuntimeChartViewport | null;
  requestViewport: RuntimeChartViewport;
}

function runtimeViewportFromSetting(
  setting: ChartInteractionViewport | null,
  authoredViewportKey: string,
): RuntimeChartViewportState | null {
  if (!setting || setting.authoredViewportKey !== authoredViewportKey) return null;
  const requestViewport = {
    start: new Date(setting.start),
    end: new Date(setting.end),
  };
  return {
    key: authoredViewportKey,
    adaptiveViewport: setting.adaptive ? requestViewport : null,
    requestViewport,
  };
}

interface ChartComposerSurfaceProps {
  spec: ChartSpec;
  setSpec: (next: ChartSpec) => void;
  focused: boolean;
  width: number;
  height: number;
  footerId: string;
  onCapture?: (capturing: boolean) => void;
}

const QUICK_ADD_CAPTURE = "quick-add";

function footerAnchorPoint(event?: PaneFooterPressEvent): { x: number; y: number } | undefined {
  const x = event?.pixelX;
  const y = event?.pixelY;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? { x, y }
    : undefined;
}

function isPriceStudyTarget(spec: ChartSpec): boolean {
  return spec.series.some((series) => (
    series.source.kind === "security"
    && (series.source.fieldId === "market.ohlcv" || series.source.fieldId === "market.close")
  ));
}

function ChartComposerSurface({
  spec,
  setSpec,
  focused,
  width,
  height,
  footerId,
  onCapture,
}: ChartComposerSurfaceProps) {
  const dialog = useDialog();
  const dispatch = useAppDispatch();
  const { publicSharing, cellWidthPx = 8 } = useUiCapabilities();
  const desktopWeb = useUiHost().kind === "desktop-web";
  const paneId = usePaneInstanceId();
  const liveStreaming = useLiveStreamingSetting();
  const dialogOpen = useDialogState((state) => state.isOpen);
  const authoredViewportKey = useMemo(() => JSON.stringify({
    range: spec.viewport.range,
    resolution: spec.viewport.resolution,
    dateWindow: spec.viewport.dateWindow ?? null,
    maxPoints: spec.viewport.maxPoints ?? null,
    sources: spec.series.map((entry) => entry.source.kind === "security"
      ? [
          entry.id,
          entry.source.kind,
          entry.source.instrument.symbol,
          entry.source.instrument.exchange ?? "",
          entry.source.fieldId,
          entry.source.period ?? "auto",
          entry.source.timestampMode
            ?? defaultFinancialTimestampMode(entry.source.fieldId)
            ?? "",
        ]
      : entry.source.kind === "economic"
        ? [entry.id, entry.source.kind, entry.source.seriesId]
        : [entry.id, entry.source.kind, chartSeriesSourceKey(entry.source)]),
  }), [spec.series, spec.viewport.dateWindow, spec.viewport.maxPoints, spec.viewport.range, spec.viewport.resolution]);
  const [storedInteractionViewport, setStoredInteractionViewport] = usePaneSettingValue<unknown>(
    CHART_INTERACTION_VIEWPORT_SETTING_KEY,
    null,
  );
  const persistedInteractionViewport = useMemo(
    () => parseChartInteractionViewport(storedInteractionViewport),
    [storedInteractionViewport],
  );
  const [runtimeViewportState, setRuntimeViewportState] = useState<RuntimeChartViewportState | null>(() => (
    runtimeViewportFromSetting(persistedInteractionViewport, authoredViewportKey)
  ));
  const runtimeViewportTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const adaptiveViewportRef = useRef<RuntimeChartViewport | null>(null);
  const requestViewportRef = useRef<RuntimeChartViewport | null>(null);
  const requestViewportOwnerRef = useRef(authoredViewportKey);
  const activeRuntimeViewport = runtimeViewportState?.key === authoredViewportKey
    ? runtimeViewportState
    : null;
  const targetPointCount = Math.max(
    MINIMUM_AUTO_RESOLUTION_POINTS,
    Math.round((width * cellWidthPx) / AUTO_RESOLUTION_BAR_PIXELS),
  );
  // The loaded resolution is the tie-breaker for the next AUTO pick, so a
  // small zoom keeps the bars it already has. Read from the previous render:
  // the resolver only consults it when the viewport moves.
  const currentResolutionRef = useRef<ManualChartResolution | null>(null);
  const resolution = useResolvedChartSpec(spec, {
    autoViewport: spec.viewport.resolution === "auto"
      ? activeRuntimeViewport?.adaptiveViewport
      : null,
    requestViewport: activeRuntimeViewport?.requestViewport,
    targetPointCount,
    currentResolution: currentResolutionRef.current,
    // Streaming follows visibility, not focus: a chart watched beside another
    // pane stays live. Focus only raises its quotes to selected priority.
    liveStreaming,
    selected: focused,
    liveRefreshIntervalMs: desktopWeb ? 0 : LIVE_CHART_TERMINAL_FRAME_MS,
  });
  currentResolutionRef.current = resolution.resolution ?? currentResolutionRef.current;
  // Intervals only resample market series. Quarterly revenue or a P/E line
  // looks the same at every interval, so such a chart offers AUTO alone.
  const hasMarketSeries = spec.series.some((entry) => (
    entry.source.kind === "security" && isMarketFieldId(entry.source.fieldId)
  ));
  const availableResolutions = useMemo<ChartResolution[]>(() => {
    if (!resolution.resolutionSupport) {
      if (!hasMarketSeries) return ["auto"];
      if (!resolution.loading) return RESOLUTIONS;
      return spec.viewport.resolution === "auto"
        ? ["auto"]
        : ["auto", spec.viewport.resolution];
    }
    const supported = new Set(getSupportedChartResolutionsForViewport(
      spec.viewport.range,
      resolution.resolutionSupport,
      spec.viewport.dateWindow,
    ));
    return RESOLUTIONS.filter((value) => value === "auto" || supported.has(value));
  }, [
    hasMarketSeries,
    resolution.loading,
    resolution.resolutionSupport,
    spec.viewport.dateWindow,
    spec.viewport.range,
    spec.viewport.resolution,
  ]);
  const resolutionOptions = useMemo(
    () => availableResolutions.map((value) => ({ label: formatChartResolution(value), value })),
    [availableResolutions],
  );
  const selectedStudies = getSelectedBuiltinStudies(spec);
  const selectedPairStudies = getSelectedPairStudies(spec);
  const viewport = resolution.viewport;
  const baseSeriesIds = useMemo(() => new Set(spec.series.map((series) => series.id)), [spec.series]);
  // Hidden series are never loaded, so the resolver has nothing to report for
  // them. Without a placeholder they vanish from the legend entirely and the
  // only way back is the series dialog.
  const legendSeries = useMemo(() => {
    const resolved = resolution.legendSeries ?? [];
    const resolvedIds = new Set(resolved.map((entry) => entry.id));
    const missing = spec.series.filter((entry) => !resolvedIds.has(entry.id));
    if (missing.length === 0) return resolution.legendSeries;
    const bySpecOrder = new Map(spec.series.map((entry, index) => [entry.id, index] as const));
    return [
      ...resolved,
      ...missing.map((entry): ResolvedSeries => ({
        id: entry.id,
        label: chartSeriesLabel(entry),
        color: entry.color ?? colors.textDim,
        unit: "",
        unitGroup: "unknown",
        nativeFrequency: "daily",
        dataShape: "scalar",
        style: entry.style,
        transform: entry.transform,
        axis: entry.axis === "right" ? "right" : "left",
        panelId: entry.panelId,
        interpolation: entry.interpolation,
        hidden: true,
        points: [],
      })),
    ].sort((a, b) => (bySpecOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (bySpecOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }, [resolution.legendSeries, spec.series]);
  const plottedSeries = useMemo(
    () => projectVisibleChartSeries(
      spec,
      resolution.bufferedSeries ?? resolution.series,
      resolution.legendSeries,
    ),
    [resolution.bufferedSeries, resolution.legendSeries, resolution.series, spec],
  );
  const { sharePane } = usePluginAppActions();
  const shareTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (shareTimerRef.current !== null) clearTimeout(shareTimerRef.current);
  }, []);
  const [interactionCaptured, setInteractionCapturedState] = useState(false);
  // Typing in quick-add must not freeze the plot: it only takes the keyboard.
  const [modalCaptured, setModalCaptured] = useState(false);
  const [quickAddWidth, setQuickAddWidth] = useState(14);
  const interactionCaptureRef = useRef(false);
  const interactionCaptureSourcesRef = useRef(new Set<string>());
  const indicatorsDialogRef = useRef<MultiSelectDialogButtonHandle | null>(null);
  const formulasDialogRef = useRef<MultiSelectDialogButtonHandle | null>(null);
  const indicatorsDisabled = !isPriceStudyTarget(spec);
  const formulasDisabled = spec.series.filter((series) => series.visible !== false).length < 2;
  const setInteractionCaptured = useCallback((source: string, captured: boolean) => {
    const sources = interactionCaptureSourcesRef.current;
    if (captured) sources.add(source);
    else sources.delete(source);
    const next = sources.size > 0;
    setModalCaptured([...sources].some((entry) => entry !== QUICK_ADD_CAPTURE));
    if (interactionCaptureRef.current === next) return;
    interactionCaptureRef.current = next;
    setInteractionCapturedState(next);
    onCapture?.(next);
  }, [onCapture]);
  const setIndicatorsOpen = useCallback(
    (open: boolean) => setInteractionCaptured("indicators", open),
    [setInteractionCaptured],
  );
  const setFormulasOpen = useCallback(
    (open: boolean) => setInteractionCaptured("formulas", open),
    [setInteractionCaptured],
  );
  const surfaceInteractive = !dialogOpen && !interactionCaptured;
  /** The plot keeps its pointer unless something modal is actually covering it. */
  const surfacePointerInteractive = !dialogOpen && !modalCaptured;
  const shortcutActive = focused && surfaceInteractive;
  const activatePane = useCallback(() => {
    if (!focused) dispatch({ type: "FOCUS_PANE", paneId });
  }, [dispatch, focused, paneId]);
  useEffect(() => {
    if (runtimeViewportTimerRef.current !== null) {
      clearTimeout(runtimeViewportTimerRef.current);
      runtimeViewportTimerRef.current = null;
    }
    const restored = runtimeViewportFromSetting(
      persistedInteractionViewport,
      authoredViewportKey,
    );
    adaptiveViewportRef.current = restored?.adaptiveViewport ?? null;
    requestViewportRef.current = restored?.requestViewport ?? null;
    requestViewportOwnerRef.current = authoredViewportKey;
    setRuntimeViewportState((current) => current?.key === authoredViewportKey ? current : restored);
    if (persistedInteractionViewport && !restored) setStoredInteractionViewport(null);
    return () => {
      if (runtimeViewportTimerRef.current !== null) {
        clearTimeout(runtimeViewportTimerRef.current);
        runtimeViewportTimerRef.current = null;
      }
    };
  }, [authoredViewportKey, persistedInteractionViewport, setStoredInteractionViewport]);
  const commitRuntimeViewport = useCallback(() => {
    const requestViewport = requestViewportRef.current;
    if (!requestViewport) return;
    const adaptiveViewport = spec.viewport.resolution === "auto"
      ? adaptiveViewportRef.current
      : null;
    setRuntimeViewportState({
      key: authoredViewportKey,
      adaptiveViewport,
      requestViewport,
    });
    setStoredInteractionViewport({
      authoredViewportKey,
      start: requestViewport.start.toISOString(),
      end: requestViewport.end.toISOString(),
      adaptive: adaptiveViewport !== null,
    } satisfies ChartInteractionViewport);
  }, [authoredViewportKey, setStoredInteractionViewport, spec.viewport.resolution]);
  const handleChartViewportChange = useCallback((
    next: { start: Date; end: Date } | null,
    _interaction: "pan" | "reset" | "zoom",
  ) => {
    if (runtimeViewportTimerRef.current !== null) {
      clearTimeout(runtimeViewportTimerRef.current);
      runtimeViewportTimerRef.current = null;
    }
    if (!next) {
      adaptiveViewportRef.current = null;
      requestViewportRef.current = null;
      setRuntimeViewportState(null);
      setStoredInteractionViewport(null);
      return;
    }
    const start = next.start.getTime();
    const end = next.end.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return;
    const viewport = { start: new Date(start), end: new Date(end) };
    requestViewportRef.current = viewport;
    requestViewportOwnerRef.current = authoredViewportKey;
    // A pan can leave the window a provider serves at the current resolution
    // just as a zoom can, so both re-pick.
    if (spec.viewport.resolution === "auto") adaptiveViewportRef.current = viewport;
    runtimeViewportTimerRef.current = globalThis.setTimeout(() => {
      runtimeViewportTimerRef.current = null;
      commitRuntimeViewport();
    }, AUTO_VIEWPORT_DEBOUNCE_MS);
  }, [authoredViewportKey, commitRuntimeViewport, spec.viewport.resolution]);
  const shareChart = useCallback(() => {
    // The share reads pane settings, so the gesture in flight lands there first.
    if (runtimeViewportTimerRef.current !== null) {
      clearTimeout(runtimeViewportTimerRef.current);
      runtimeViewportTimerRef.current = null;
      commitRuntimeViewport();
    }
    if (shareTimerRef.current !== null) return;
    shareTimerRef.current = globalThis.setTimeout(() => {
      shareTimerRef.current = null;
      sharePane(paneId);
    }, SHARE_SETTLE_DELAY_MS);
  }, [commitRuntimeViewport, paneId, sharePane]);

  useRemoteUiNode({
    role: "chart-data",
    label: "Rendered chart composer data",
    metadata: chartComposerSemanticMetadata(
      spec,
      resolution,
      activeRuntimeViewport?.requestViewport,
    ),
  });

  const openSeriesEditor = useCallback(async () => {
    setInteractionCaptured("prompt", true);
    try {
      const next = await dialog.prompt<ChartSpec | null>({
        closeOnClickOutside: true,
        size: "large",
        content: (context: PromptContext<ChartSpec | null>) => (
          <SeriesEditorDialog {...context} initialSpec={spec} />
        ),
      }).catch(() => null);
      if (next) setSpec(next);
    } finally {
      setInteractionCaptured("prompt", false);
    }
  }, [dialog, setInteractionCaptured, setSpec, spec]);

  const setRange = useCallback((range: TimeRange) => {
    setSpec({
      ...spec,
      viewport: { ...spec.viewport, range, dateWindow: undefined, maxPoints: undefined },
    });
  }, [setSpec, spec]);
  const setResolution = useCallback((next: ChartResolution) => {
    setSpec({ ...spec, viewport: { ...spec.viewport, resolution: next } });
  }, [setSpec, spec]);
  useEffect(() => {
    if (
      spec.viewport.resolution === "auto"
      || availableResolutions.includes(spec.viewport.resolution)
    ) {
      return;
    }
    setResolution("auto");
  }, [availableResolutions, setResolution, spec.viewport.resolution]);
  const openResolutionPicker = useCallback(async () => {
    setInteractionCaptured("prompt", true);
    try {
      const next = await dialog.prompt<string>({
        closeOnClickOutside: true,
        content: (context: PromptContext<string>) => (
          <ChoiceDialog
            {...context}
            title="Chart Resolution"
            selectedChoiceId={spec.viewport.resolution}
            choices={availableResolutions.map((value) => ({
              id: value,
              label: formatChartResolution(value),
              description: describeChartResolution(value),
            }))}
          />
        ),
      }).catch(() => "");
      if (availableResolutions.includes(next as ChartResolution)) setResolution(next as ChartResolution);
    } finally {
      setInteractionCaptured("prompt", false);
    }
  }, [
    availableResolutions,
    dialog,
    setInteractionCaptured,
    setResolution,
    spec.viewport.resolution,
  ]);
  const toggleSeries = useCallback((seriesId: string) => {
    const next = toggleChartSeries(spec, seriesId);
    if (next !== spec) setSpec(next);
  }, [setSpec, spec]);
  const isSeriesToggleable = useCallback(
    (series: { id: string }) => baseSeriesIds.has(series.id) && canToggleChartSeries(spec, series.id),
    [baseSeriesIds, spec],
  );
  const handleQuickAddActiveChange = useCallback(
    (active: boolean) => setInteractionCaptured(QUICK_ADD_CAPTURE, active),
    [setInteractionCaptured],
  );
  useShortcut((event) => {
    if (interactionCaptureRef.current || dialogOpen) return;
    if (publicSharing && isPlainKey(event, "y")) {
      event.preventDefault();
      event.stopPropagation();
      shareChart();
      return;
    }
    const shortcut = resolveChartComposerShortcut(event, RANGES.length);
    if (!shortcut) return;
    event.preventDefault();
    event.stopPropagation();

    if (typeof shortcut !== "string") {
      setRange(RANGES[shortcut.index]!);
      return;
    }
    switch (shortcut) {
      case "reload":
        resolution.reload();
        return;
      case "series":
        void openSeriesEditor();
        return;
      case "resolution":
        if (availableResolutions.length > 1) void openResolutionPicker();
    }
  }, { enabled: focused && !dialogOpen });

  const comparisonNotice = resolution.priceComparison?.notice;
  const comparisonHasNoWindow = resolution.priceComparison?.start === null;
  // A partial history seed cannot establish that the requested comparison failed.
  const comparisonUnavailable = comparisonHasNoWindow && !resolution.loading
    ? "Comparison unavailable: need two shared dates and a nonzero baseline."
    : null;
  const statusError = resolution.errors[0];
  const spreadUnitError = spec.studies.some((study) => study.kind === "spread"
    && statusError?.startsWith(`${study.id}: spread cannot subtract `)
    && statusError.endsWith("; inputs require matching known units, currencies and scales."));
  const statusErrorNotice = spreadUnitError
    ? "Spread unavailable: incompatible or unknown units."
    : statusError;
  // Failed series use their authored id in errors and their display label in warnings.
  const errorSeries = spec.series.find((entry) => statusError?.startsWith(`${entry.label ?? entry.id}: `));
  const errorMessage = errorSeries ? statusError?.slice(`${errorSeries.label ?? errorSeries.id}: `.length) : undefined;
  const errorSeriesLabel = legendSeries?.find((entry) => entry.id === errorSeries?.id)?.label;
  const duplicateErrorNotices = new Set([statusError, errorMessage,
    errorSeriesLabel && errorMessage ? `${errorSeriesLabel}: ${errorMessage}` : undefined]);
  // A failed shared window empties every compared leg; one comparison message explains it.
  const comparisonEmptyNotices = new Set(comparisonHasNoWindow
    ? resolution.legendSeries?.filter((entry) => resolution.priceComparison?.seriesIds.includes(entry.id))
      .map((entry) => `${entry.label}: no observations in the selected date range.`)
    : []);
  const statusWarnings = resolution.warnings.filter((warning) => (
    warning !== FINANCIAL_VINTAGE_NOTICE && warning !== SEC_EPS_BASIS_NOTICE && warning !== comparisonNotice
    && !FORWARD_VALUATION_BASIS_NOTICES.has(warning)
    && !duplicateErrorNotices.has(warning) && !comparisonEmptyNotices.has(warning)
    && !spec.studies.some((study) => (
      (study.kind === "ratio" && warning.startsWith(`${study.id}: ratio inputs use different currencies (`)
        && warning.endsWith("); raw values are not FX-converted."))
      || (study.kind === "correlation" && warning.startsWith(`${study.id}: correlation mixes `)
        && warning.endsWith("; only matching observation times contribute."))
    ))
  ));
  const statusNotices = [...new Set([...(statusErrorNotice ? [statusErrorNotice] : []), ...(comparisonUnavailable ? [comparisonUnavailable] : []), ...statusWarnings])];
  usePaneNoticeFooter({
    registrationId: `${footerId}:notices`,
    notices: statusNotices,
    focused: shortcutActive,
    title: "Chart data",
  });

  // Footer registrations compare presentation, so their callbacks must read current actions.
  const currentActionsRef = useRef({ openSeriesEditor, openResolutionPicker, shareChart });
  currentActionsRef.current = { openSeriesEditor, openResolutionPicker, shareChart };
  const footerSeries = useCallback(() => { void currentActionsRef.current.openSeriesEditor(); }, []);
  const footerResolution = useCallback(() => { void currentActionsRef.current.openResolutionPicker(); }, []);
  const footerShare = useCallback(() => { currentActionsRef.current.shareChart(); }, []);
  const openIndicators = useCallback((event?: PaneFooterPressEvent) => {
    indicatorsDialogRef.current?.open(footerAnchorPoint(event));
  }, []);
  const openFormulas = useCallback((event?: PaneFooterPressEvent) => {
    formulasDialogRef.current?.open(footerAnchorPoint(event));
  }, []);

  usePaneFooter(footerId, () => ({
    info: resolution.loading
      ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }]
      : [],
    hints: [
      { id: "series", key: "s", label: "eries", onPress: footerSeries },
      { id: "indicators", key: "i", label: "ndicators", onPress: openIndicators, disabled: indicatorsDisabled },
      { id: "formulas", key: "f", label: "ormulas", onPress: openFormulas, disabled: formulasDisabled },
      { id: "resolution", key: "t", label: "imeframe", onPress: footerResolution },
      ...(publicSharing ? [{ id: "share", key: "y", label: " share", onPress: footerShare }] : []),
    ],
  }), [resolution.loading, footerSeries, openIndicators, indicatorsDisabled, openFormulas, formulasDisabled, footerResolution, publicSharing, footerShare]);

  // A fixed window (a GIP session) highlights no range, so the bar names it.
  const dateWindowLabel = useMemo(() => {
    const window = spec.viewport.dateWindow;
    if (!window) return undefined;
    const exchange = spec.series.find((entry) => entry.source.kind === "security")?.source;
    const timeZone = exchange?.kind === "security"
      ? resolveExchangeTimeZone(exchange.instrument.exchange) ?? "UTC"
      : "UTC";
    return formatChartDateWindow(window, timeZone);
  }, [spec.series, spec.viewport.dateWindow]);

  const emptyMessage = spec.series.length === 0
    ? "Add a series to start the chart"
    : resolution.loading
      ? "Loading chart data"
      : statusErrorNotice ?? comparisonUnavailable ?? "No observations in this range";

  return (
    <Box flexDirection="column" width={width} height={height} backgroundColor={colors.panel}>
      <QueryBar
        width={width}
        filters={[
          { id: "range", label: "Range", inline: true,
            value: spec.viewport.dateWindow ? "" : spec.viewport.range,
            options: RANGE_OPTIONS,
            onChange: (value: string) => setRange(value as TimeRange) },
        ]}
        view={resolutionOptions.length > 1 ? {
          value: spec.viewport.resolution,
          options: resolutionOptions,
          onChange: (value: string) => setResolution(value as ChartResolution),
        } : undefined}
        meta={dateWindowLabel}
      />
      <MultiSelectDialogButton
        ref={indicatorsDialogRef}
        label="Indicators"
        title="Chart Indicators"
        options={CHART_STUDY_OPTIONS}
        selectedValues={selectedStudies}
        onChange={(values) => setSpec(setBuiltinStudies(spec, values as BuiltinStudySelection[]))}
        disabled={indicatorsDisabled}
        idPrefix={`${footerId}:indicators`}
        shortcutKey="i"
        shortcutActive={shortcutActive}
        onOpenChange={setIndicatorsOpen}
        renderTrigger={() => null}
      />
      <MultiSelectDialogButton
        ref={formulasDialogRef}
        label="Formulas"
        title="Pair Formulas"
        options={CHART_FORMULA_OPTIONS}
        selectedValues={selectedPairStudies}
        onChange={(values) => setSpec(setPairStudies(spec, values as PairStudySelection[]))}
        disabled={formulasDisabled}
        idPrefix={`${footerId}:formulas`}
        shortcutKey="f"
        shortcutActive={shortcutActive}
        onOpenChange={setFormulasOpen}
        renderTrigger={() => null}
      />
      <Box flexGrow={1} minHeight={4}>
        <CompositeChart
          series={plottedSeries}
          legendSeries={legendSeries}
          timelineSeries={resolution.timelineSeries}
          panels={spec.panels}
          viewport={viewport}
          clipToViewport={!!spec.viewport.dateWindow}
          viewportResetKey={authoredViewportKey}
          width={Math.max(1, width)}
          height={Math.max(4, height - 1)}
          focused={focused}
          interactive={surfacePointerInteractive}
          allowHistoricalBackfill
          showLatestChangePercent={!spec.viewport.dateWindow && spec.viewport.range === "1D"}
          onViewportChange={handleChartViewportChange}
          onActivate={activatePane}
          onToggleSeries={toggleSeries}
          isSeriesToggleable={isSeriesToggleable}
          emptyMessage={emptyMessage}
          legendAccessory={(
            <ChartSeriesQuickAdd
              spec={spec}
              setSpec={setSpec}
              focused={focused}
              width={Math.max(8, Math.min(36, width - 1))}
              height={height}
              shortcutEnabled={surfaceInteractive}
              shortcutBlocked={dialogOpen}
              onActivatePane={activatePane}
              onActiveChange={handleQuickAddActiveChange}
              onWidthChange={setQuickAddWidth}
            />
          )}
          legendAccessoryWidth={quickAddWidth}
        />
      </Box>
    </Box>
  );
}

export function ChartComposerPane({ paneId, focused, width, height }: PaneProps) {
  const { symbol, error } = usePaneTicker();
  const instance = usePaneInstance();
  const follows = instance?.binding?.kind === "follow";
  const selectTarget = useMemo(() => {
    let current: InstrumentRef | null = null;
    return (state: AppState) => {
      const next = follows ? resolveInstrumentForPane(state, paneId) : null;
      // The resolver creates objects; equivalent snapshots must stay stable
      // while a same-symbol contract selection still triggers a render.
      if (JSON.stringify(next) !== JSON.stringify(current)) current = next;
      return current;
    };
  }, [follows, paneId]);
  const target = useAppSelector(selectTarget);
  const previousTarget = useRef<InstrumentRef | null>(target);
  const fallback = useMemo(
    () => symbol ? buildPriceChartPreset(symbol) : buildEmptyChartPreset(),
    [symbol],
  );
  const updateSettings = useUpdatePaneSettings();
  const storedSpec = instance?.settings?.[CHART_SPEC_SETTING_KEY] ?? fallback;
  const savedIds = instance?.settings?.[CHART_FOLLOW_SERIES_SETTING_KEY];
  const stored = useMemo(() => parseChartSpecOr(storedSpec, fallback), [fallback, storedSpec]);
  const ownedIds = useMemo(
    () => resolveFollowSeriesIds(stored, previousTarget.current, target, savedIds),
    [savedIds, stored, target],
  );
  // Resolve before rendering so the new title never carries the old asset's data.
  const spec = useMemo(
    () => follows ? rebindFollowChartSpec(stored, previousTarget.current, target, ownedIds) : stored,
    [follows, ownedIds, stored, target],
  );
  const setSpec = useCallback((next: ChartSpec) => updateSettings({
    [CHART_SPEC_SETTING_KEY]: next,
    ...(follows ? { [CHART_FOLLOW_SERIES_SETTING_KEY]: resolveFollowSeriesIds(next, target, target, ownedIds) } : {}),
  }), [follows, ownedIds, target, updateSettings]);
  useEffect(() => {
    if (follows && target && (spec !== stored || ownedIds !== savedIds)) {
      setSpec(spec);
    }
    if (target) previousTarget.current = target;
  }, [follows, ownedIds, savedIds, setSpec, spec, stored, target]);
  if (follows && !target && ownedIds.length > 0) {
    return <EmptyState title={error ?? "No ticker selected."} />;
  }
  return (
    <ChartComposerSurface
      spec={spec}
      setSpec={setSpec}
      focused={focused}
      width={width}
      height={height}
      footerId={`${CHART_COMPOSER_PANE_ID}:${paneId}`}
    />
  );
}

export function ChartComposerResearchTab({ focused, width, height, onCapture }: TickerResearchTabProps) {
  const { symbol: paneSymbol, ticker } = usePaneTicker();
  const symbol = paneSymbol ? publicTickerKey(paneSymbol, ticker?.metadata.exchange) : null;
  const fallback = useMemo(() => symbol ? buildPriceChartPreset(symbol) : buildEmptyChartPreset(), [symbol]);
  const [storedSpec, setStoredSpec] = usePaneSettingValue<unknown>(CHART_SPEC_SETTING_KEY, fallback);
  const spec = useMemo(() => parseChartSpecOr(storedSpec, fallback), [fallback, storedSpec]);
  const previousSymbolRef = useRef(symbol);

  useEffect(() => {
    if (!symbol) return;
    const rebound = rebindResearchChartSpec(spec, previousSymbolRef.current, symbol);
    if (rebound !== spec) setStoredSpec(rebound);
    previousSymbolRef.current = symbol;
  }, [setStoredSpec, spec, symbol]);

  return (
    <ChartComposerSurface
      spec={spec}
      setSpec={setStoredSpec}
      focused={focused}
      width={width}
      height={height}
      footerId="chart-composer:research"
      onCapture={onCapture}
    />
  );
}
