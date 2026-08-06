import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Box,
  Text,
  useNativeRenderer,
  useUiHost,
  type BoxRenderable,
  type InputRenderable,
} from "../../../ui";
import { InlineQuickAddRow, ListView, type ListViewItem } from "../../../components/ui";
import { getNativeSurfaceManager } from "../../../components/chart/native/surface/manager";
import { getRenderableCellRect } from "../../../components/chart/native/surface/visibility";
import { useShortcut } from "../../../react/input";
import { useAppInputCapture } from "../../../state/app/input-capture";
import { useOptionalPaneInstanceId } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { ChartSpec } from "../../../time-series/types";
import { getSharedRegistry } from "../../registry";
import { MAX_CHART_COMPOSER_SERIES } from "./chart-spec";
import { appendChartSeries } from "./presets";
import type { SeriesCatalogInstrument, SeriesCatalogSuggestion } from "./series-catalog";
import { useSeriesCatalogSuggestions } from "./use-series-catalog";

const MAX_VISIBLE_SUGGESTIONS = 4;
const CHART_TOOLBAR_HEIGHT = 1;
const MINIMUM_CHART_HEIGHT = 4;
const QUICK_ADD_ROW_HEIGHT = 1;
const IDLE_QUICK_ADD_WIDTH = 14;
const ACTIVE_QUICK_ADD_WIDTH = 36;

interface ClosestElementLike {
  closest(selector: string): {
    getAttribute(name: string): string | null;
  } | null;
}

export function isChartQuickAddMouseTarget(target: unknown, quickAddId: string): boolean {
  if (!target || typeof target !== "object") return false;
  const candidate = target as Partial<ClosestElementLike> & {
    parentElement?: Partial<ClosestElementLike> | null;
  };
  const element = typeof candidate.closest === "function" ? candidate : candidate.parentElement;
  if (!element || typeof element.closest !== "function") return false;
  const root = element.closest("[data-gloom-chart-quick-add]");
  return root?.getAttribute("data-gloom-chart-quick-add") === quickAddId;
}

function clampSelection(index: number, length: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(index, length - 1));
}

function defaultCatalogInstrument(spec: ChartSpec): SeriesCatalogInstrument {
  const security = spec.series.find((series) => series.source.kind === "security");
  const instrument = security?.source.kind === "security" ? security.source.instrument : undefined;
  const symbol = instrument?.symbol ?? "AAPL";
  const registry = getSharedRegistry();
  const saved = typeof registry?.getTickerFn === "function"
    ? registry.getTickerFn(symbol)
    : undefined;
  return {
    symbol,
    ...(instrument?.exchange
      ? { exchange: instrument.exchange }
      : saved?.metadata.exchange
        ? { exchange: saved.metadata.exchange }
        : {}),
    ...(saved?.metadata.name ? { name: saved.metadata.name } : {}),
  };
}

export function ChartSeriesQuickAdd({
  spec,
  setSpec,
  focused,
  width,
  height,
  shortcutEnabled,
  shortcutBlocked,
  onActivatePane,
  dismissSignal,
  onActiveChange,
  onWidthChange,
}: {
  spec: ChartSpec;
  setSpec: (spec: ChartSpec) => void;
  focused: boolean;
  width: number;
  height: number;
  shortcutEnabled: boolean;
  shortcutBlocked: boolean;
  onActivatePane: () => void;
  /** Bumped by the pane when something else takes the pointer. */
  dismissSignal?: number;
  onActiveChange?: (active: boolean) => void;
  onWidthChange?: (width: number) => void;
}) {
  const ui = useUiHost();
  const nativeRenderer = useNativeRenderer();
  const paneId = useOptionalPaneInstanceId();
  const quickAddId = useId();
  const inputRef = useRef<InputRenderable | null>(null);
  const drawerRef = useRef<BoxRenderable | null>(null);
  const commitLockRef = useRef(false);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const defaultInstrument = useMemo(() => defaultCatalogInstrument(spec), [spec]);
  const { suggestions, loading } = useSeriesCatalogSuggestions({
    query,
    defaultInstrument,
    enabled: active,
  });
  const controlWidth = active
    ? Math.max(8, Math.min(ACTIVE_QUICK_ADD_WIDTH, width))
    : Math.max(8, Math.min(IDLE_QUICK_ADD_WIDTH, width));
  const drawerStatus = error
    ?? (loading && suggestions.length === 0
      ? "Searching instruments…"
      : active && query.trim().length > 0 && suggestions.length === 0
        ? "No matching security or metric."
        : null);
  const maximumDrawerHeight = Math.max(
    0,
    Math.min(
      MAX_VISIBLE_SUGGESTIONS,
      height - CHART_TOOLBAR_HEIGHT - MINIMUM_CHART_HEIGHT - QUICK_ADD_ROW_HEIGHT,
    ),
  );
  const drawerHeight = active
    ? Math.min(maximumDrawerHeight, drawerStatus ? 1 : suggestions.length)
    : 0;
  const nativeSurfaceManager = useMemo(
    () => getNativeSurfaceManager(nativeRenderer),
    [nativeRenderer],
  );
  useAppInputCapture(inputFocused && focused);

  useEffect(() => {
    const occluderId = `${quickAddId}:drawer`;
    if (ui.kind === "desktop-web" || drawerHeight <= 0 || !paneId || !drawerRef.current) {
      nativeSurfaceManager.removeLocalOccluder(occluderId);
      return;
    }

    const drawer = drawerRef.current as BoxRenderable & { onLifecyclePass?: (() => void) | null };
    const previousLifecyclePass = drawer.onLifecyclePass;
    const syncOccluder = () => {
      if (
        typeof drawer.x !== "number"
        || typeof drawer.y !== "number"
        || typeof drawer.width !== "number"
        || typeof drawer.height !== "number"
      ) {
        return;
      }
      nativeSurfaceManager.upsertLocalOccluder({
        id: occluderId,
        paneId,
        rect: getRenderableCellRect(drawer as Parameters<typeof getRenderableCellRect>[0]),
      });
    };
    const lifecyclePass = () => {
      previousLifecyclePass?.();
      syncOccluder();
    };
    drawer.onLifecyclePass = lifecyclePass;
    nativeRenderer.registerLifecyclePass(drawer);
    syncOccluder();
    const mountTimer = setTimeout(syncOccluder, 0);

    return () => {
      clearTimeout(mountTimer);
      nativeRenderer.unregisterLifecyclePass(drawer);
      if (drawer.onLifecyclePass === lifecyclePass) drawer.onLifecyclePass = previousLifecyclePass;
      nativeSurfaceManager.removeLocalOccluder(occluderId);
    };
  }, [drawerHeight, nativeRenderer, nativeSurfaceManager, paneId, quickAddId, ui.kind]);

  useEffect(() => {
    onActiveChange?.(inputFocused && focused);
  }, [focused, inputFocused, onActiveChange]);

  useEffect(() => {
    onWidthChange?.(controlWidth);
  }, [controlWidth, onWidthChange]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, suggestions.length]);

  useEffect(() => {
    if (focused || !active) return;
    setActive(false);
    setInputFocused(false);
    inputRef.current?.blur?.();
  }, [active, focused]);

  const dismissedSignalRef = useRef(dismissSignal);
  useEffect(() => {
    if (dismissSignal === dismissedSignalRef.current) return;
    dismissedSignalRef.current = dismissSignal;
    if (!active && !inputFocused) return;
    setActive(false);
    setInputFocused(false);
    onActiveChange?.(false);
    inputRef.current?.blur?.();
  }, [active, dismissSignal, inputFocused, onActiveChange]);

  useEffect(() => {
    if (ui.kind !== "desktop-web" || !inputFocused) return;

    const handleOutsideMouseDown = (event: globalThis.MouseEvent) => {
      if (isChartQuickAddMouseTarget(event.target, quickAddId)) return;
      inputRef.current?.blur?.();
    };

    document.addEventListener("mousedown", handleOutsideMouseDown, true);
    return () => document.removeEventListener("mousedown", handleOutsideMouseDown, true);
  }, [inputFocused, quickAddId, ui.kind]);

  const cancelPendingBlur = useCallback(() => {
    if (blurTimerRef.current === null) return;
    clearTimeout(blurTimerRef.current);
    blurTimerRef.current = null;
  }, []);

  useEffect(() => cancelPendingBlur, [cancelPendingBlur]);

  const clearInput = useCallback(() => {
    setQuery("");
    inputRef.current?.editBuffer.setText?.("");
    inputRef.current?.setCursorOffset?.(0);
  }, []);

  const focusInput = useCallback(() => {
    cancelPendingBlur();
    onActivatePane();
    setActive(true);
    setInputFocused(true);
    onActiveChange?.(true);
    setError(null);
    queueMicrotask(() => inputRef.current?.focus?.());
  }, [cancelPendingBlur, onActivatePane, onActiveChange]);

  const commitSuggestion = useCallback((suggestion: SeriesCatalogSuggestion | undefined) => {
    if (!suggestion || commitLockRef.current) return;
    cancelPendingBlur();
    if (spec.series.length >= MAX_CHART_COMPOSER_SERIES) {
      setError(`Charts support up to ${MAX_CHART_COMPOSER_SERIES} base series.`);
      return;
    }
    commitLockRef.current = true;
    queueMicrotask(() => {
      commitLockRef.current = false;
    });
    setSpec(appendChartSeries(spec, suggestion.expression).spec);
    clearInput();
    setSelectedIndex(0);
    setError(null);
    setActive(false);
    setInputFocused(false);
    onActiveChange?.(false);
    queueMicrotask(() => inputRef.current?.blur?.());
  }, [cancelPendingBlur, clearInput, onActiveChange, setSpec, spec]);

  const submit = useCallback(() => {
    commitSuggestion(suggestions[clampSelection(selectedIndex, suggestions.length)]);
  }, [commitSuggestion, selectedIndex, suggestions]);
  const cancel = useCallback(() => {
    cancelPendingBlur();
    inputRef.current?.blur?.();
    clearInput();
    setActive(false);
    setInputFocused(false);
    onActiveChange?.(false);
    setError(null);
  }, [cancelPendingBlur, clearInput, onActiveChange]);

  useShortcut((event) => {
    if (!focused) return;
    if (!active) {
      if (
        event.name === "n"
        && event.targetEditable !== true
        && !event.ctrl
        && !event.meta
        && !event.super
        && !event.alt
      ) {
        event.preventDefault?.();
        event.stopPropagation?.();
        focusInput();
      }
      return;
    }
    if (event.name === "escape") {
      event.preventDefault?.();
      event.stopPropagation?.();
      cancel();
    } else if (event.name === "up") {
      event.preventDefault?.();
      event.stopPropagation?.();
      setSelectedIndex((current) => clampSelection(current - 1, suggestions.length));
    } else if (event.name === "down") {
      event.preventDefault?.();
      event.stopPropagation?.();
      setSelectedIndex((current) => clampSelection(current + 1, suggestions.length));
    }
  }, {
    phase: "before",
    allowEditable: true,
    enabled: focused && !shortcutBlocked && (shortcutEnabled || active),
  });

  const items = useMemo<ListViewItem[]>(() => suggestions.map((suggestion) => ({
    id: suggestion.id,
    label: suggestion.label,
    description: suggestion.description,
    detail: suggestion.detail,
  })), [suggestions]);

  return (
    <Box
      position="relative"
      width={controlWidth}
      height={1}
      flexShrink={0}
      overflow="visible"
      backgroundColor={colors.panel}
      zIndex={30}
      data-gloom-role="chart-series-quick-add"
      data-gloom-chart-quick-add={quickAddId}
    >
      <InlineQuickAddRow
        value={query}
        active={inputFocused}
        paneFocused={focused}
        width={controlWidth}
        rowWidth={controlWidth}
        placeholder="add series"
        inputRef={inputRef}
        minInputWidth={Math.max(4, controlWidth - 4)}
        maxInputWidth={Math.max(4, controlWidth - 4)}
        onFocusRequest={focusInput}
        onChange={(value) => {
          setQuery(value);
          setError(null);
          if (!active) setActive(true);
          if (!inputFocused) setInputFocused(true);
        }}
        onSubmit={submit}
        onFocus={() => {
          cancelPendingBlur();
          setInputFocused(true);
        }}
        onBlur={() => {
          setInputFocused(false);
          onActiveChange?.(false);
          cancelPendingBlur();
          blurTimerRef.current = setTimeout(() => {
            blurTimerRef.current = null;
            clearInput();
            setSelectedIndex(0);
            setError(null);
            setActive(false);
          }, 0);
        }}
        onCancel={cancel}
      />
      {drawerHeight > 0 ? (
        <Box
          ref={drawerRef}
          position="absolute"
          left={0}
          top={1}
          width={controlWidth}
          height={drawerHeight}
          overflow="hidden"
          backgroundColor={colors.panel}
          zIndex={31}
          onMouseDown={(event: {
            preventDefault?: () => void;
            stopPropagation?: () => void;
          }) => {
            cancelPendingBlur();
            event.preventDefault?.();
            event.stopPropagation?.();
          }}
        >
          {drawerStatus ? (
            <Box
              width={controlWidth}
              height={1}
              paddingX={1}
              overflow="hidden"
              backgroundColor={colors.panel}
            >
              <Text fg={error ? colors.warning : colors.textDim}>{drawerStatus}</Text>
            </Box>
          ) : (
            <ListView
              items={items}
              selectedIndex={clampSelection(selectedIndex, items.length)}
              height={drawerHeight}
              surface="plain"
              bgColor={colors.panel}
              scrollable={items.length > drawerHeight}
              rowGap={0}
              selectOnHover
              onSelect={setSelectedIndex}
              onActivate={(_, index) => commitSuggestion(suggestions[index])}
              remoteLabel="Chart series suggestions"
            />
          )}
        </Box>
      ) : null}
    </Box>
  );
}
