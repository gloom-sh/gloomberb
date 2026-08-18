import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useUiHost } from "../../../ui";
import {
  ChoiceDialog,
  Tabs,
  usePaneFooter,
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
import { getSupportedChartResolutionsForViewport } from "../../../time-series/resolution";
import { useResolvedChartSpec } from "../../../time-series/hooks";
import { chartSeriesSourceKey } from "../../../capabilities";
import { useShortcut } from "../../../react/input";
import { useDialog, useDialogState, type PromptContext } from "../../../ui/dialog";
import {
  useAppDispatch,
  usePaneInstanceId,
  usePaneSettingValue,
  usePaneTicker,
} from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { CHART_COMPOSER_PANE_ID } from "../../../types/config";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { SeriesEditorDialog } from "./editor";
import { chartComposerSemanticMetadata } from "./semantic";
import {
  canToggleChartSeries,
  CHART_SPEC_SETTING_KEY,
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
  rebindChartSecuritySymbol,
  type BuiltinStudySelection,
  type PairStudySelection,
} from "./presets";
import {
  CHART_FORMULA_OPTIONS,
  CHART_RANGES as RANGES,
  CHART_RESOLUTIONS as RESOLUTIONS,
  CHART_STUDY_OPTIONS,
} from "./settings";
import { resolveChartComposerShortcut } from "./shortcuts";
import { ChartSeriesQuickAdd } from "./quick-add";
import { useLiveStreamingSetting } from "../shared/live-streaming";

const RANGE_TABS = RANGES.map((range, index) => ({ label: `${index + 1}:${range}`, value: range }));
const AUTO_VIEWPORT_DEBOUNCE_MS = 350;

interface RuntimeChartViewport {
  start: Date;
  end: Date;
}

function footerAnchorPoint(event?: PaneFooterPressEvent): { x: number; y: number } | undefined {
  const x = event?.pixelX;
  const y = event?.pixelY;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? { x, y }
    : undefined;
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
  const isDesktopWeb = useUiHost().kind === "desktop-web";
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
  const [runtimeViewportState, setRuntimeViewportState] = useState<{
    key: string;
    adaptiveViewport: RuntimeChartViewport | null;
    requestViewport: RuntimeChartViewport;
  } | null>(null);
  const runtimeViewportTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const adaptiveViewportRef = useRef<RuntimeChartViewport | null>(null);
  const requestViewportRef = useRef<RuntimeChartViewport | null>(null);
  const activeRuntimeViewport = runtimeViewportState?.key === authoredViewportKey
    ? runtimeViewportState
    : null;
  const targetPointCount = Math.max(60, Math.floor(width * 1.25));
  const resolution = useResolvedChartSpec(spec, {
    autoViewport: spec.viewport.resolution === "auto"
      ? activeRuntimeViewport?.adaptiveViewport
      : null,
    requestViewport: activeRuntimeViewport?.requestViewport,
    targetPointCount,
    liveStreaming,
  });
  const availableResolutions = useMemo<ChartResolution[]>(() => {
    if (!resolution.resolutionSupport) {
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
    resolution.loading,
    resolution.resolutionSupport,
    spec.viewport.dateWindow,
    spec.viewport.range,
    spec.viewport.resolution,
  ]);
  const resolutionTabs = useMemo(
    () => availableResolutions.map((value) => ({ label: value.toUpperCase(), value })),
    [availableResolutions],
  );
  const resolutionTabsWidth = useMemo(
    () => resolutionTabs.reduce((total, tab) => total + [...tab.label].length + 1, 0),
    [resolutionTabs],
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
    adaptiveViewportRef.current = null;
    requestViewportRef.current = null;
    setRuntimeViewportState((current) => current?.key === authoredViewportKey ? current : null);
    return () => {
      if (runtimeViewportTimerRef.current !== null) {
        clearTimeout(runtimeViewportTimerRef.current);
        runtimeViewportTimerRef.current = null;
      }
    };
  }, [authoredViewportKey]);
  const handleChartViewportChange = useCallback((
    next: { start: Date; end: Date } | null,
    interaction: "pan" | "reset" | "sync" | "zoom",
  ) => {
    if (interaction === "sync") return;
    if (runtimeViewportTimerRef.current !== null) {
      clearTimeout(runtimeViewportTimerRef.current);
      runtimeViewportTimerRef.current = null;
    }
    if (!next) {
      adaptiveViewportRef.current = null;
      requestViewportRef.current = null;
      setRuntimeViewportState(null);
      return;
    }
    const start = next.start.getTime();
    const end = next.end.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return;
    const viewport = { start: new Date(start), end: new Date(end) };
    requestViewportRef.current = viewport;
    if (interaction === "zoom" && spec.viewport.resolution === "auto") {
      adaptiveViewportRef.current = viewport;
    }
    runtimeViewportTimerRef.current = globalThis.setTimeout(() => {
      runtimeViewportTimerRef.current = null;
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
    }, AUTO_VIEWPORT_DEBOUNCE_MS);
  }, [authoredViewportKey, spec.viewport.resolution]);

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
  const openRangePicker = useCallback(async () => {
    setInteractionCaptured("prompt", true);
    try {
      const range = await dialog.prompt<string>({
        closeOnClickOutside: true,
        content: (context: PromptContext<string>) => (
          <ChoiceDialog
            {...context}
            title="Chart Range"
            selectedChoiceId={spec.viewport.dateWindow ? undefined : spec.viewport.range}
            choices={RANGES.map((value) => ({
              id: value,
              label: value,
              description: `Show the latest ${value === "ALL" ? "available history" : value}.`,
            }))}
          />
        ),
      }).catch(() => "");
      if (RANGES.includes(range as TimeRange)) setRange(range as TimeRange);
    } finally {
      setInteractionCaptured("prompt", false);
    }
  }, [dialog, setInteractionCaptured, setRange, spec.viewport.dateWindow, spec.viewport.range]);
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
              label: value.toUpperCase(),
              description: value === "auto"
                ? "Choose an interval automatically for the active range."
                : `Use ${value.toUpperCase()} observations.`,
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
  const openIndicators = useCallback((event?: PaneFooterPressEvent) => {
    indicatorsDialogRef.current?.open(footerAnchorPoint(event));
  }, []);
  const openFormulas = useCallback((event?: PaneFooterPressEvent) => {
    formulasDialogRef.current?.open(footerAnchorPoint(event));
  }, []);
  const currentActionsRef = useRef({
    openSeriesEditor,
    openResolutionPicker,
    openRangePicker,
  });
  currentActionsRef.current = {
    openSeriesEditor,
    openResolutionPicker,
    openRangePicker,
  };
  const footerSeries = useCallback(() => { void currentActionsRef.current.openSeriesEditor(); }, []);
  const footerResolution = useCallback(() => { void currentActionsRef.current.openResolutionPicker(); }, []);
  const footerRange = useCallback(() => { void currentActionsRef.current.openRangePicker(); }, []);

  useShortcut((event) => {
    if (interactionCaptureRef.current || dialogOpen) return;
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
        void openResolutionPicker();
    }
  }, { enabled: focused && !dialogOpen });

  usePaneFooter(footerId, () => ({
    info: [
      ...(resolution.loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(resolution.errors[0] ? [{ id: "error", parts: [{ text: resolution.errors[0], tone: "warning" as const }] }] : []),
      ...(!resolution.errors[0] && resolution.warnings[0]
        ? [{ id: "warning", parts: [{ text: resolution.warnings[0], tone: "warning" as const }] }]
        : []),
    ],
    hints: [
      { id: "series", key: "s", label: "eries", onPress: footerSeries },
      { id: "indicators", key: "i", label: "ndicators", onPress: openIndicators, disabled: indicatorsDisabled },
      { id: "formulas", key: "f", label: "ormulas", onPress: openFormulas, disabled: formulasDisabled },
      { id: "resolution", key: "r", label: "es", onPress: footerResolution },
      { id: "range", key: "1-8", label: "range", onPress: footerRange },
    ],
  }), [
    footerRange,
    footerResolution,
    footerSeries,
    formulasDisabled,
    indicatorsDisabled,
    openFormulas,
    openIndicators,
    resolution.errors,
    resolution.loading,
    resolution.warnings,
  ]);

  const emptyMessage = spec.series.length === 0
    ? "Add a series to start the chart"
    : resolution.loading
      ? "Loading chart data"
      : resolution.errors[0] ?? "No observations in this range";

  return (
    <Box flexDirection="column" width={width} height={height} backgroundColor={colors.panel}>
      <Box flexDirection="row" height={1} paddingX={1} gap={0} overflow="hidden">
        <Box
          flexShrink={0}
          height={1}
          maxWidth={52}
          overflow="hidden"
          // Desktop tabs are laid out in pixels, so a cell budget clips them
          // while the row still has room to spare.
          style={isDesktopWeb ? { maxWidth: "none", width: "auto" } : undefined}
        >
          <Tabs
            tabs={RANGE_TABS}
            activeValue={spec.viewport.dateWindow ? null : spec.viewport.range}
            onSelect={(value) => setRange(value as TimeRange)}
            compact
            dense
            variant="bare"
            focused={focused}
            keyboardNavigation={false}
          />
        </Box>

        <Box flexGrow={1} minWidth={0} height={1} />
        <Box
          flexShrink={1}
          minWidth={0}
          width={resolutionTabsWidth}
          height={1}
          overflow="hidden"
          style={isDesktopWeb ? { width: "auto", flexShrink: 0 } : undefined}
          data-gloom-role="chart-resolution-control"
        >
          <Tabs
            tabs={resolutionTabs}
            activeValue={spec.viewport.resolution}
            onSelect={(value) => setResolution(value as ChartResolution)}
            compact
            dense
            variant="bare"
            focused={focused}
            keyboardNavigation={false}
          />
        </Box>
      </Box>
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
  const { symbol } = usePaneTicker();
  const fallback = useMemo(
    () => symbol ? buildPriceChartPreset(symbol) : buildEmptyChartPreset(),
    [symbol],
  );
  const [storedSpec, setStoredSpec] = usePaneSettingValue<unknown>(CHART_SPEC_SETTING_KEY, fallback);
  const spec = useMemo(() => parseChartSpecOr(storedSpec, fallback), [fallback, storedSpec]);
  return (
    <ChartComposerSurface
      spec={spec}
      setSpec={setStoredSpec}
      focused={focused}
      width={width}
      height={height}
      footerId={`${CHART_COMPOSER_PANE_ID}:${paneId}`}
    />
  );
}

export function ChartComposerResearchTab({ focused, width, height, onCapture }: TickerResearchTabProps) {
  const { symbol } = usePaneTicker();
  const fallback = useMemo(() => symbol ? buildPriceChartPreset(symbol) : buildEmptyChartPreset(), [symbol]);
  const [storedSpec, setStoredSpec] = usePaneSettingValue<unknown>(CHART_SPEC_SETTING_KEY, fallback);
  const spec = useMemo(() => parseChartSpecOr(storedSpec, fallback), [fallback, storedSpec]);
  const previousSymbolRef = useRef(symbol);

  useEffect(() => {
    const previousSymbol = previousSymbolRef.current;
    previousSymbolRef.current = symbol;
    if (!symbol || !previousSymbol || symbol === previousSymbol) return;
    const rebound = rebindChartSecuritySymbol(spec, previousSymbol, symbol);
    if (rebound !== spec) setStoredSpec(rebound);
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
