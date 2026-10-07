import { FINANCIAL_VINTAGE_NOTICE, SEC_EPS_BASIS_NOTICE } from "../../../utils/financial-statements";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useUiCapabilities } from "../../../ui";
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
  NumberPromptDialog,
  TextPromptDialog,
  type MultiSelectDialogButtonHandle,
  type MultiSelectRowAction,
} from "../../../components/ui";
import { CompositeChart } from "../../../components/chart/composite";
import type { CompositeChartLevels, CompositeLevelEdit } from "../../../components/chart/composite/levels";
import type { PaneProps, TickerResearchTabProps } from "../../../types/plugin";
import type { ChartResolution, TimeRange } from "../../../components/chart/core/types";
import type { ChartSpec, ResolvedSeries } from "../../../time-series/types";
import {
  getSupportedChartResolutionsForViewport,
  isIntradayResolution,
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
import { isUsListingExchange, parsePublicTickerKey, publicTickerKey, resolveExchangeTimeZone } from "../../../utils/exchanges";
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
  futuresGenericNotice,
  futuresGenericRollFromValue,
  futuresGenericRollLabel,
  futuresGenericRollValue,
  type FuturesGenericAdjust,
} from "../../../utils/futures-generic";
import { chartSeriesLabel } from "./series-expression";
import {
  chartFuturesGeneric,
  defaultFinancialTimestampMode,
  setChartFuturesGeneric,
  rebindResearchChartSpec,
} from "./chart-spec-edit";
import {
  builtinStudyPeriod,
  builtinStudySetting,
  builtinVwapAnchors,
  getSelectedBuiltinStudies,
  getSelectedPairStudies,
  isNumberSettingStudy,
  isPeriodStudy,
  parseVwapAnchor,
  setBuiltinStudies,
  setBuiltinStudyPeriod,
  setBuiltinStudySetting,
  setBuiltinVwapAnchors,
  setPairStudies,
  STUDY_NUMBER_SETTINGS,
  STUDY_PERIOD_MAX,
  STUDY_PERIOD_MIN,
  type BuiltinStudySelection,
  type PairStudySelection,
} from "./studies";
import { buildEmptyChartPreset, buildPriceChartPreset } from "./presets";
import type { ChartInteractionViewport } from "./chart-spec";
import {
  CHART_FORMULA_OPTIONS,
  CHART_RANGES as RANGES,
  CHART_RESOLUTIONS as RESOLUTIONS,
  chartStudyOptionsFor,
  chartStudyPeriodTitle,
  chartStudySettingLabel,
} from "./settings";
import { resolveChartComposerShortcut } from "./shortcuts";
import { describeChartResolution, formatChartDateWindow, formatChartResolution } from "./viewport-labels";
import { ChartSeriesQuickAdd } from "./quick-add";
import { useLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import { usePluginAppActions, usePluginConfigState } from "../../runtime";
import { usePluginRenderContext } from "../../runtime/context";
import { activePriceAlertsFor, addLevelAlert, PRICE_ALERTS_STORE, type AlertTarget } from "../alerts/levels";
import { formatAlertDescription } from "../alerts/alert-engine";
import { alertInstrument, syncAlertQuoteStream } from "../alerts/live";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { getActiveQuoteDisplay } from "../../../market-data/market/status";
import { resolveEntryData } from "../../../market-data/selectors";
import { editPriceLevels, parsePriceLevels, PRICE_LEVELS_KEY, priceLevelTickerKey } from "./price-levels";
import { canonicalExchange } from "../../../utils/exchanges";
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

const GENERIC_ROLL_OPTIONS = [
  { value: "oi", label: "OI switch" },
  { value: "f5", label: "5d before notice" },
  { value: "d15", label: "Day 15" },
];

const GENERIC_ADJUST_OPTIONS = [
  { value: "none", label: "None" },
  { value: "ratio", label: "Ratio" },
  { value: "difference", label: "Difference" },
];

function footerAnchorPoint(event?: PaneFooterPressEvent): { x: number; y: number } | undefined {
  const x = event?.pixelX;
  const y = event?.pixelY;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? { x, y }
    : undefined;
}

/** An alert's level, and a drawn level that has one, take this colour. */
const ALERT_LEVEL_COLOR = "#ff6b6b";

/**
 * The listing price levels belong to: the chart's first price series shown
 * in its own values, under the exchange its data resolved to.
 */
function levelListing(spec: ChartSpec, series: readonly ResolvedSeries[]): {
  seriesId: string;
  key: string;
  target: AlertTarget;
  instrument: InstrumentRef;
  lastPrice: number | null;
} | null {
  const entry = spec.series.find((candidate) => (
    candidate.visible !== false
    && candidate.transform === "raw"
    && candidate.source.kind === "security"
    && (candidate.source.fieldId === "market.ohlcv" || candidate.source.fieldId === "market.close")
  ));
  const resolved = entry ? series.find((candidate) => candidate.id === entry.id) : undefined;
  if (!entry || entry.source.kind !== "security" || !resolved) return null;
  const exchange = resolved.timeBasis?.exchange || canonicalExchange(entry.source.instrument.exchange) || undefined;
  const last = resolved.points.findLast((point) => Number.isFinite(point.close ?? point.value));
  return {
    seriesId: entry.id,
    key: priceLevelTickerKey(entry.source.instrument.symbol, exchange),
    target: { symbol: entry.source.instrument.symbol, exchange },
    instrument: entry.source.instrument,
    lastPrice: last ? last.close ?? last.value : null,
  };
}

/**
 * The price an alert at a level is set against: the quote the alert will be
 * judged on, else the chart's. The chart's newest close is the fallback only,
 * since a date window that ends in the past would make an old close current
 * and point the alert the wrong way.
 */
function currentListingPrice(listing: { target: AlertTarget; instrument: InstrumentRef; lastPrice: number | null }): number | null {
  const coordinator = getSharedMarketDataCoordinator();
  for (const instrument of coordinator ? [alertInstrument(listing.target), listing.instrument] : []) {
    const price = getActiveQuoteDisplay(resolveEntryData(coordinator!.getQuoteEntry(instrument)))?.price;
    if (typeof price === "number" && Number.isFinite(price)) return price;
  }
  return listing.lastPrice;
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
  const desktopWeb = useUiCapabilities().nativePaneChrome === true;
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
  const { sharePane, notify } = usePluginAppActions();
  const { runtime } = usePluginRenderContext();
  const [levelStore, setLevelStore] = usePluginConfigState<unknown>(PRICE_LEVELS_KEY, null);
  const alertsJson = useAppSelector((state) => state.config.pluginConfig[PRICE_ALERTS_STORE.pluginId]?.[PRICE_ALERTS_STORE.key]);
  const alertsOn = useAppSelector((state) => !state.config.disabledPlugins.includes(PRICE_ALERTS_STORE.pluginId));
  // The listing only changes with the chart's ticker; the last price moves
  // every tick, so it is read at the moment an alert is made.
  const freshListing = levelListing(spec, resolution.bufferedSeries ?? resolution.series);
  const listingRef = useRef(freshListing);
  listingRef.current = freshListing;
  const listing = useMemo(
    () => listingRef.current,
    [freshListing?.seriesId, freshListing?.key, freshListing?.target.symbol, freshListing?.target.exchange],
  );
  const editLevels = useCallback((edit: CompositeLevelEdit) => {
    const key = listingRef.current?.key;
    if (!key) return;
    setLevelStore((current: unknown) => {
      const stored = parsePriceLevels(current);
      const next = editPriceLevels(stored, key, edit.kind === "remove" ? edit : { kind: edit.kind, id: edit.id, price: edit.value });
      // An edit that changed nothing writes nothing, so it never reaches sync.
      return next === stored ? current : next;
    });
  }, [setLevelStore]);
  const alertAtLevel = useCallback(async (price: number) => {
    const current = listingRef.current;
    if (!current) return;
    const result = addLevelAlert(
      runtime.getConfigState<string>(PRICE_ALERTS_STORE.pluginId, PRICE_ALERTS_STORE.key),
      current.target,
      price,
      currentListingPrice(current),
    );
    if ("error" in result) {
      notify({ body: `Saved alerts could not be read: ${result.error}`, type: "error" });
      return;
    }
    if (result.created) {
      await runtime.setConfigState(PRICE_ALERTS_STORE.pluginId, PRICE_ALERTS_STORE.key, result.json);
      syncAlertQuoteStream();
    }
    notify({
      body: `${result.created ? "Alert set" : "Alert already set"}: ${formatAlertDescription(result.alert)}`,
      type: "success",
    });
  }, [notify, runtime]);
  const chartLevels = useMemo<CompositeChartLevels | null>(() => {
    if (!listing) return null;
    const stored = parsePriceLevels(levelStore)[listing.key] ?? [];
    const alerts = alertsOn ? activePriceAlertsFor(alertsJson, listing.target) : [];
    const alerted = new Set(alerts.map((alert) => alert.targetPrice));
    const drawn = new Set(stored.map((level) => level.price));
    const alertOnly = [...new Map(alerts.filter((alert) => !drawn.has(alert.targetPrice))
      .map((alert) => [alert.targetPrice, alert] as const)).values()];
    return {
      seriesId: listing.seriesId,
      items: [
        ...stored.map((level) => ({
          id: level.id,
          value: level.price,
          color: alerted.has(level.price) ? ALERT_LEVEL_COLOR : level.color,
          editable: true,
          actionable: alertsOn && !alerted.has(level.price),
        })),
        ...alertOnly.map((alert) => ({
          id: `alert:${alert.id}`,
          value: alert.targetPrice,
          color: ALERT_LEVEL_COLOR,
          editable: false,
          actionable: false,
        })),
      ],
      onEdit: editLevels,
      ...(alertsOn ? { action: { label: "alert", title: "Alert at Level", run: (level) => { void alertAtLevel(level.value); } } } : {}),
    };
  }, [alertAtLevel, alertsJson, alertsOn, editLevels, levelStore, listing]);
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
  // The Indicators dialog keeps the callbacks it opened with; reading the spec
  // through this ref keeps a toggle from undoing a period edit made meanwhile.
  const specRef = useRef(spec);
  specRef.current = spec;
  const studyOptions = useMemo(() => chartStudyOptionsFor(spec), [spec]);
  const updateSpec = useCallback((nextSpec: ChartSpec) => {
    specRef.current = nextSpec;
    setSpec(nextSpec);
  }, [setSpec]);
  // Picking an anchor on the plot starts once the Indicators dialog is out of the way.
  const [pickingAnchor, setPickingAnchor] = useState(false);
  const pickAnchorAfterDialogRef = useRef(false);
  const anchorInputRef = useRef<ResolvedSeries | undefined>(undefined);
  const avwapInputId = spec.studies.find((study) => study.kind === "anchored-vwap" && study.id.startsWith("builtin:"))?.inputSeriesIds[0];
  anchorInputRef.current = (resolution.bufferedSeries ?? resolution.series).find((entry) => entry.id === avwapInputId);
  const editVwapAnchors = useCallback(async (): Promise<string | { close: true } | void> => {
    const anchors = builtinVwapAnchors(specRef.current);
    const labels = new Map((resolution.legendSeries ?? []).map((entry) => [entry.id, entry.label] as const));
    const choice = await dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (ctx: PromptContext<string>) => (
        <ChoiceDialog
          {...ctx}
          title="VWAP anchors"
          choices={[
            { id: "pick", label: "Pick a bar on the chart" },
            { id: "date", label: "Enter a date" },
            ...anchors.map((anchor) => {
              const avwap = [...labels].find(([id]) => id.endsWith(`:${anchor}`))?.[1];
              return { id: `remove:${anchor}`, label: `Remove ${avwap ?? new Date(anchor).toISOString().slice(0, 16).replace("T", " ")}` };
            }),
          ]}
        />
      ),
    }).catch(() => undefined);
    if (choice === "pick") {
      pickAnchorAfterDialogRef.current = true;
      return { close: true };
    }
    if (choice?.startsWith("remove:")) {
      const anchor = Number(choice.slice("remove:".length));
      const nextSpec = setBuiltinVwapAnchors(specRef.current, anchors.filter((entry) => entry !== anchor));
      updateSpec(nextSpec);
      return chartStudySettingLabel("anchored-vwap", nextSpec);
    }
    if (choice !== "date") return;
    const text = await dialog.prompt<string>({
      content: (ctx: PromptContext<string>) => (
        <TextPromptDialog {...ctx} title="Anchor VWAP at" placeholder="2026-09-30 or 2026-09-30 10:00" confirmLabel="Anchor" width={44} />
      ),
    }).catch(() => undefined);
    if (!text) return;
    const anchor = parseVwapAnchor(text, anchorInputRef.current);
    if (anchor === null) {
      notify({ body: `No bar at ${text}. Use a date like 2026-09-30 or 2026-09-30 10:00.`, type: "error" });
      return;
    }
    const nextSpec = setBuiltinVwapAnchors(specRef.current, [...builtinVwapAnchors(specRef.current), anchor]);
    updateSpec(nextSpec);
    return chartStudySettingLabel("anchored-vwap", nextSpec);
  }, [dialog, notify, resolution.legendSeries, updateSpec]);
  const studySettingsAction = useMemo<MultiSelectRowAction>(() => ({
    label: "Period",
    shortcut: "p",
    labelFor: (value) => value === "anchored-vwap" ? "Anchors" : value === "vwap" ? "Bands" : value === "volume-profile" ? "Rows" : "Period",
    shortcutFor: (value) => value === "anchored-vwap" ? "a" : value === "vwap" ? "b" : value === "volume-profile" ? "n" : "p",
    appliesTo: (value, selected) => selected && (isPeriodStudy(value) || isNumberSettingStudy(value) || value === "anchored-vwap"),
    run: async (value) => {
      if (value === "anchored-vwap") return editVwapAnchors();
      if (isNumberSettingStudy(value)) {
        const { min, max } = STUDY_NUMBER_SETTINGS[value];
        const current = builtinStudySetting(specRef.current, value);
        const next = await dialog.prompt<number>({
          content: (ctx: PromptContext<number>) => (
            <NumberPromptDialog
              {...ctx}
              title={value === "vwap" ? "VWAP bands (standard deviations, 0 for none)" : "Volume profile rows"}
              initialValue={current}
              min={min}
              max={max}
              invalidMessage={`Whole number from ${min} to ${max}`}
            />
          ),
        });
        if (next === undefined || next === current) return;
        const nextSpec = setBuiltinStudySetting(specRef.current, value, next);
        updateSpec(nextSpec);
        return chartStudySettingLabel(value, nextSpec);
      }
      if (!isPeriodStudy(value)) return;
      const current = builtinStudyPeriod(specRef.current, value) ?? STUDY_PERIOD_MIN;
      const next = await dialog.prompt<number>({
        content: (ctx: PromptContext<number>) => (
          <NumberPromptDialog
            {...ctx}
            title={chartStudyPeriodTitle(value)}
            initialValue={current}
            min={STUDY_PERIOD_MIN}
            max={STUDY_PERIOD_MAX}
            invalidMessage={`Whole number from ${STUDY_PERIOD_MIN} to ${STUDY_PERIOD_MAX}`}
          />
        ),
      });
      if (next === undefined || next === current) return;
      const nextSpec = setBuiltinStudyPeriod(specRef.current, value, next);
      updateSpec(nextSpec);
      return chartStudySettingLabel(value, nextSpec);
    },
  }), [dialog, editVwapAnchors, updateSpec]);
  const timePick = useMemo(() => pickingAnchor ? {
    label: "anchor here",
    onPick: (date: Date) => {
      setPickingAnchor(false);
      updateSpec(setBuiltinVwapAnchors(specRef.current, [...builtinVwapAnchors(specRef.current), date.getTime()]));
    },
    onCancel: () => setPickingAnchor(false),
  } : null, [pickingAnchor, updateSpec]);
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
  const setIndicatorsOpen = useCallback((open: boolean) => {
    setInteractionCaptured("indicators", open);
    if (open || !pickAnchorAfterDialogRef.current) return;
    pickAnchorAfterDialogRef.current = false;
    setPickingAnchor(true);
  }, [setInteractionCaptured]);
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

  const anchoredVwapOn = selectedStudies.includes("anchored-vwap");
  useEffect(() => {
    if (!anchoredVwapOn) setPickingAnchor(false);
  }, [anchoredVwapOn]);
  const anchorable = anchoredVwapOn && !pickingAnchor;
  const footerAnchor = useCallback(() => setPickingAnchor(true), []);
  usePaneFooter(footerId, () => ({
    info: resolution.loading
      ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }]
      : pickingAnchor
        ? [{ id: "anchor", parts: [{ text: "pick a bar to anchor VWAP", tone: "muted" as const }] }]
        : [],
    hints: [
      { id: "series", key: "s", label: "eries", onPress: footerSeries },
      { id: "indicators", key: "i", label: "ndicators", onPress: openIndicators, disabled: indicatorsDisabled },
      { id: "formulas", key: "f", label: "ormulas", onPress: openFormulas, disabled: formulasDisabled },
      { id: "resolution", key: "t", label: "imeframe", onPress: footerResolution },
      ...(anchorable ? [{ id: "vwap-anchor", key: "v", label: "wap anchor", title: "Anchor VWAP", onPress: footerAnchor }] : []),
      ...(publicSharing ? [{ id: "share", key: "y", label: " share", onPress: footerShare }] : []),
    ],
  }), [resolution.loading, pickingAnchor, footerSeries, openIndicators, indicatorsDisabled, openFormulas, formulasDisabled, footerResolution, anchorable, footerAnchor, publicSharing, footerShare]);

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

  // A generic future (CL1) is a rolling series: its roll rule and adjustment are chart controls.
  const generic = useMemo(() => chartFuturesGeneric(spec), [spec]);
  const genericFilters = useMemo(() => {
    if (!generic) return [];
    const roll = futuresGenericRollValue(generic.roll);
    const rollOptions = GENERIC_ROLL_OPTIONS.map((option) => option.value === "f5"
      ? { ...option, label: futuresGenericNotice(generic.root) === "first notice" ? "5d before notice" : "5d before last trade" }
      : option);
    if (!rollOptions.some((option) => option.value === roll)) rollOptions.push({ value: roll, label: futuresGenericRollLabel(generic) });
    const update = (change: Parameters<typeof setChartFuturesGeneric>[1]) => {
      const next = setChartFuturesGeneric(specRef.current, change);
      specRef.current = next;
      setSpec(next);
    };
    return [
      { id: "roll", label: "Roll", value: roll, options: rollOptions, title: "Roll rule",
        onChange: (value: string) => {
          const next = futuresGenericRollFromValue(value);
          if (next) update({ roll: next });
        } },
      { id: "adjust", label: "Adjust", value: generic.adjust, options: GENERIC_ADJUST_OPTIONS, title: "Adjustment",
        onChange: (value: string) => update({ adjust: value as FuturesGenericAdjust }) },
    ];
  }, [generic, setSpec]);

  // Pre-market and after-hours bars exist for US listings' intraday history.
  // The toggle stays while it is on, so it can always be turned off.
  const extendedHoursOn = spec.viewport.extendedHours === true;
  const extendedHoursListing = useMemo(() => {
    const primary = (resolution.bufferedSeries ?? resolution.series).find((entry) => entry.observationKind === "market" && entry.listing);
    if (!primary?.listing || !primary.historyResolution) return null;
    return isUsListingExchange(primary.listing.exchange) && isIntradayResolution(primary.historyResolution);
  }, [resolution.bufferedSeries, resolution.series]);
  const extendedHoursShownRef = useRef(false);
  // Keep the last answer while a reload has none, so the bar does not jump.
  if (extendedHoursListing !== null) extendedHoursShownRef.current = extendedHoursListing;
  const extendedHoursFilters = extendedHoursOn || extendedHoursShownRef.current
    ? [{
      id: "extended-hours",
      kind: "toggle" as const,
      label: "Extended hours",
      short: "Ext hours",
      value: extendedHoursOn,
      onChange: (value: boolean) => {
        const { extendedHours: _previous, ...viewport } = specRef.current.viewport;
        updateSpec({ ...specRef.current, viewport: value ? { ...viewport, extendedHours: true } : viewport });
      },
    }]
    : [];

  const emptyMessage = spec.series.length === 0
    ? "Add a series to start the chart"
    : resolution.loading
      ? "Loading chart data"
      : statusErrorNotice ?? comparisonUnavailable ?? "No observations in this range";

  return (
    <Box flexDirection="column" width={width} height={height}>
      <QueryBar
        width={width}
        filters={[
          { id: "range", label: "Range", inline: true,
            value: spec.viewport.dateWindow ? "" : spec.viewport.range,
            options: RANGE_OPTIONS,
            onChange: (value: string) => setRange(value as TimeRange) },
          ...genericFilters,
          ...extendedHoursFilters,
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
        options={studyOptions}
        selectedValues={selectedStudies}
        onChange={(values) => {
          const previous = getSelectedBuiltinStudies(specRef.current);
          const nextSpec = setBuiltinStudies(specRef.current, values as BuiltinStudySelection[]);
          // A new anchored VWAP has nothing to draw until it has an anchor.
          if (values.includes("anchored-vwap") && !previous.includes("anchored-vwap") && builtinVwapAnchors(nextSpec).length === 0) {
            pickAnchorAfterDialogRef.current = true;
          } else if (!values.includes("anchored-vwap")) {
            pickAnchorAfterDialogRef.current = false;
          }
          updateSpec(nextSpec);
        }}
        rowAction={studySettingsAction}
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
          timePick={timePick}
          levels={chartLevels}
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

const sameTicker = (left: string, right: string) => (
  parsePublicTickerKey(left).symbol.toUpperCase() === parsePublicTickerKey(right).symbol.toUpperCase()
);

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
  // What the chart showed while it followed, and the saved spec it drew that from. Unlinking pins it
  // there, even when that spec was only rebound for display and never saved (see below).
  const shown = useRef<{ spec: ChartSpec; stored: ChartSpec } | null>(null);
  const binding = instance?.binding;
  // Only an unlink or a closed list pins in place: the same saved spec, now fixed on the ticker
  // last followed. An undo, another device's unlink or another layout brings its own saved spec
  // and binding, and is shown as saved.
  const unlinkedFrom = !follows && shown.current && binding?.kind === "fixed" && previousTarget.current
    && sameTicker(binding.symbol, previousTarget.current.symbol)
    && (stored === shown.current.stored || JSON.stringify(stored) === JSON.stringify(shown.current.stored))
    ? shown.current.spec
    : null;
  // Resolve before rendering so the new title never carries the old asset's data.
  const spec = useMemo(
    () => follows ? rebindFollowChartSpec(stored, previousTarget.current, target, ownedIds) : unlinkedFrom ?? stored,
    [follows, ownedIds, stored, target, unlinkedFrom],
  );
  const setSpec = useCallback((next: ChartSpec) => updateSettings({
    [CHART_SPEC_SETTING_KEY]: next,
    ...(follows ? { [CHART_FOLLOW_SERIES_SETTING_KEY]: resolveFollowSeriesIds(next, target, target, ownedIds) } : {}),
  }), [follows, ownedIds, target, updateSettings]);
  // The rebound spec is saved once per target. A spec synced in from another device, whose list
  // cursor sits elsewhere, is rebound for display only: saving it would push it back, and two
  // devices following the same list would rewrite each other on every sync.
  const savedForTarget = useRef<string | null>(null);
  useEffect(() => {
    const targetKey = target ? JSON.stringify(target) : null;
    if (follows && target && ((spec !== stored && targetKey !== savedForTarget.current) || ownedIds !== savedIds)) {
      setSpec(spec);
    }
    if (unlinkedFrom && JSON.stringify(unlinkedFrom) !== JSON.stringify(stored)) {
      updateSettings({ [CHART_SPEC_SETTING_KEY]: unlinkedFrom });
    }
    shown.current = follows && target ? { spec, stored } : null;
    if (target) {
      previousTarget.current = target;
      savedForTarget.current = targetKey;
    }
  }, [follows, ownedIds, savedIds, setSpec, spec, stored, target, unlinkedFrom, updateSettings]);
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
