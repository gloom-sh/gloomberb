import { useEffect, useMemo, useRef, useState } from "react";
import type { InputRenderable } from "../../../../ui";
import type { ListViewItem } from "../../../../components/ui";
import { useDialogKeyboard } from "../../../../ui/dialog";
import type {
  ChartSeriesSpec,
  ChartSpec,
  PanelScale,
  SeriesPeriod,
  SeriesStyle,
  SeriesTimestampMode,
  SeriesTransform,
} from "../../../../time-series/types";
import { validateChartSpec } from "../../../../time-series/spec";
import { isPlainKey } from "../../../../utils/keyboard";
import { getSharedRegistry } from "../../../registry";
import {
  canToggleChartSeries,
  MAX_CHART_COMPOSER_SERIES,
  parseChartSpecOr,
} from "../chart-spec";
import {
  appendChartSeries,
  applySeriesStyle,
  applySeriesTimestampMode,
  buildEmptyChartPreset,
  buildSeriesSpec,
  chartSeriesLabel,
  formatSeriesExpression,
  getCompatibleSeriesStyles,
  getCompatibleSeriesTransforms,
  getSelectedBuiltinStudies,
  getSelectedPairStudies,
  parseSeriesExpression,
  setBuiltinStudies,
  setPairStudies,
} from "../presets";
import type { SeriesCatalogInstrument, SeriesCatalogSuggestion } from "../series-catalog";
import { useSeriesCatalogSuggestions } from "../use-series-catalog";
import type {
  SeriesEditorFieldId,
  SeriesEditorFocus,
} from "./model";
import {
  buildSeriesEditorActions,
  buildSeriesEditorFields,
  getSeriesEditorFieldIds,
  getSeriesTimestampMode,
  supportsSeriesTimestampMode,
  titleCaseSeriesEditorValue,
} from "./model";

function clampIndex(value: number, length: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(value, length - 1));
}

function seriesFieldId(series: ChartSeriesSpec): string {
  return series.source.kind === "security" ? series.source.fieldId : series.source.seriesId;
}

function timingDescription(series: ChartSeriesSpec): string | null {
  if (!supportsSeriesTimestampMode(series)) return null;
  return getSeriesTimestampMode(series) === "available-at" ? "Available date" : "Period end";
}

function pruneSpec(spec: ChartSpec): ChartSpec {
  const selectedBuiltinStudies = getSelectedBuiltinStudies(spec);
  const selectedPairStudies = getSelectedPairStudies(spec);
  const rebound = setPairStudies(
    setBuiltinStudies(spec, selectedBuiltinStudies),
    selectedPairStudies,
  );
  const seriesIds = new Set(rebound.series.map((series) => series.id));
  const studies = rebound.studies.filter((study) => {
    const requiredInputs = study.kind === "ratio" || study.kind === "spread" || study.kind === "correlation" ? 2 : 1;
    return study.inputSeriesIds.length === requiredInputs
      && study.inputSeriesIds.every((id) => seriesIds.has(id));
  });
  const panels = [...rebound.panels];
  if (!panels.some((panel) => panel.id === "main")) panels.unshift({ id: "main" });
  return { ...rebound, panels, studies };
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((entry, entryIndex) => entryIndex === index ? value : entry);
}

function moveAt<T>(values: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= values.length) return [...values];
  const next = [...values];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function useSeriesEditorController({
  dialogId,
  resolve,
  initialSpec,
  isDesktop,
}: {
  dialogId?: string;
  resolve: (value: ChartSpec | null) => void;
  initialSpec: ChartSpec;
  isDesktop: boolean;
}) {
  const [draft, setDraft] = useState(() => parseChartSpecOr(initialSpec, buildEmptyChartPreset()));
  const [selectedIndex, setSelectedIndex] = useState(() => clampIndex(0, initialSpec.series.length));
  const [expression, setExpression] = useState(() => initialSpec.series[0] ? formatSeriesExpression(initialSpec.series[0]) : "");
  const [editingExpression, setEditingExpression] = useState(false);
  const [quickAddActive, setQuickAddActive] = useState(true);
  const [quickAddQuery, setQuickAddQuery] = useState("");
  const [quickAddSelection, setQuickAddSelection] = useState(0);
  const [keyboardFocus, setKeyboardFocus] = useState<SeriesEditorFocus>("add");
  const [error, setError] = useState<string | null>(null);
  const expressionRef = useRef<InputRenderable | null>(null);
  const quickAddRef = useRef<InputRenderable | null>(null);
  const keyboardFocusRef = useRef<SeriesEditorFocus>("add");
  const catalogCommitLockRef = useRef(false);
  const expressionCommitLockRef = useRef(false);
  const selected = selectedIndex >= 0 ? draft.series[selectedIndex] ?? null : null;
  const keyboardFields = useMemo<SeriesEditorFieldId[]>(
    () => getSeriesEditorFieldIds(selected),
    [selected],
  );
  const keyboardTargets = useMemo<SeriesEditorFocus[]>(() => [
    "add",
    ...(selected ? ["series" as const, "source" as const, ...keyboardFields] : []),
  ], [keyboardFields, selected]);

  const activateQuickAdd = () => {
    setQuickAddActive(true);
  };

  const deactivateQuickAdd = () => {
    setQuickAddActive(false);
  };

  const updateKeyboardFocus = (target: SeriesEditorFocus) => {
    keyboardFocusRef.current = target;
    setKeyboardFocus(target);
  };

  const focusKeyboardTarget = (target: SeriesEditorFocus) => {
    if (!keyboardTargets.includes(target)) return;
    updateKeyboardFocus(target);
    if (target === "add") {
      setEditingExpression(false);
      expressionRef.current?.blur?.();
      activateQuickAdd();
      queueMicrotask(() => quickAddRef.current?.focus?.());
      return;
    }

    deactivateQuickAdd();
    quickAddRef.current?.blur?.();
    if (target === "source") {
      setEditingExpression(true);
      queueMicrotask(() => expressionRef.current?.focus?.());
    } else {
      setEditingExpression(false);
      expressionRef.current?.blur?.();
    }
  };

  const moveKeyboardFocus = (direction: -1 | 1) => {
    const currentIndex = Math.max(0, keyboardTargets.indexOf(keyboardFocusRef.current));
    const nextIndex = (currentIndex + direction + keyboardTargets.length) % keyboardTargets.length;
    const next = keyboardTargets[nextIndex];
    if (next) focusKeyboardTarget(next);
  };

  useEffect(() => {
    const next = selected ? formatSeriesExpression(selected) : "";
    setExpression(next);
    setError(null);
    setEditingExpression(false);
  }, [selected?.id]);

  const defaultInstrument = useMemo<SeriesCatalogInstrument>(() => {
    const firstSecurity = draft.series.find((series) => series.source.kind === "security");
    const security = selected?.source.kind === "security"
      ? selected.source.instrument
      : firstSecurity?.source.kind === "security"
        ? firstSecurity.source.instrument
        : undefined;
    const symbol = security?.symbol ?? "AAPL";
    const saved = getSharedRegistry()?.getTickerFn(symbol);
    return {
      symbol,
      ...(security?.exchange ? { exchange: security.exchange } : saved?.metadata.exchange ? { exchange: saved.metadata.exchange } : {}),
      ...(saved?.metadata.name ? { name: saved.metadata.name } : {}),
    };
  }, [draft.series, selected]);
  const {
    suggestions: quickAddSuggestions,
    loading: quickAddLoading,
  } = useSeriesCatalogSuggestions({
    query: quickAddQuery,
    defaultInstrument,
    enabled: quickAddActive,
  });

  useEffect(() => {
    setQuickAddSelection(0);
  }, [quickAddQuery, quickAddSuggestions.length]);

  useEffect(() => {
    if (!keyboardTargets.includes(keyboardFocus)) updateKeyboardFocus("add");
  }, [keyboardFocus, keyboardTargets]);

  const updateSelected = (update: (series: ChartSeriesSpec) => ChartSeriesSpec) => {
    if (!selected) return;
    setDraft((current) => ({
      ...current,
      series: replaceAt(current.series, selectedIndex, update(current.series[selectedIndex]!)),
    }));
  };

  const commitExpression = (): boolean => {
    if (expressionCommitLockRef.current) return true;
    if (!selected) return false;
    const parsed = parseSeriesExpression(expression);
    if (!parsed) {
      setError("Use SYMBOL, SYMBOL:field, FRED:series, or CAP:capability-id:series-id.");
      return false;
    }
    expressionCommitLockRef.current = true;
    queueMicrotask(() => {
      expressionCommitLockRef.current = false;
    });

    const candidate = buildSeriesSpec(parsed, selectedIndex);
    const previousFieldId = seriesFieldId(selected);
    const nextFieldId = seriesFieldId(candidate);
    const styles = getCompatibleSeriesStyles(nextFieldId);
    const transforms = getCompatibleSeriesTransforms(nextFieldId);
    const source = candidate.source.kind === "security" && selected.source.kind === "security"
      ? {
        ...candidate.source,
        ...(previousFieldId === nextFieldId
          ? { period: selected.source.period }
          : {}),
        ...(supportsSeriesTimestampMode(candidate) && supportsSeriesTimestampMode(selected)
          ? { timestampMode: getSeriesTimestampMode(selected) }
          : {}),
        instrument: candidate.source.instrument.symbol === selected.source.instrument.symbol
          && (candidate.source.instrument.exchange ?? "") === (selected.source.instrument.exchange ?? "")
          ? selected.source.instrument
          : candidate.source.instrument,
      }
      : candidate.source;
    const style = previousFieldId === nextFieldId || styles.includes(selected.style)
      ? selected.style
      : candidate.style;
    const next = applySeriesStyle({
      ...candidate,
      id: selected.id,
      source,
      ...(selected.label ? { label: selected.label } : {}),
      ...(selected.color ? { color: selected.color } : {}),
      ...(selected.visible !== undefined ? { visible: selected.visible } : {}),
      style,
      transform: previousFieldId === nextFieldId || transforms.includes(selected.transform)
        ? selected.transform
        : candidate.transform,
      axis: selected.axis,
      panelId: selected.panelId,
    }, style);
    setDraft((current) => ({ ...current, series: replaceAt(current.series, selectedIndex, next) }));
    setExpression(formatSeriesExpression(next));
    setEditingExpression(false);
    expressionRef.current?.blur?.();
    setError(null);
    return true;
  };

  const clearQuickAddInput = () => {
    setQuickAddQuery("");
    quickAddRef.current?.editBuffer.setText?.("");
    quickAddRef.current?.setCursorOffset?.(0);
  };

  const beginQuickAdd = (reset = false) => {
    if (draft.series.length >= MAX_CHART_COMPOSER_SERIES) {
      setError(`Charts support up to ${MAX_CHART_COMPOSER_SERIES} base series.`);
      return;
    }
    if (reset) clearQuickAddInput();
    updateKeyboardFocus("add");
    setEditingExpression(false);
    activateQuickAdd();
    setError(null);
    quickAddRef.current?.focus?.();
    if (reset) {
      queueMicrotask(() => {
        clearQuickAddInput();
        quickAddRef.current?.focus?.();
      });
    }
  };

  const addCatalogSuggestion = (suggestion: SeriesCatalogSuggestion | undefined) => {
    if (!suggestion || catalogCommitLockRef.current) return;
    if (draft.series.length >= MAX_CHART_COMPOSER_SERIES) {
      setError(`Charts support up to ${MAX_CHART_COMPOSER_SERIES} base series.`);
      return;
    }
    catalogCommitLockRef.current = true;
    queueMicrotask(() => {
      catalogCommitLockRef.current = false;
    });
    const appended = appendChartSeries(draft, suggestion.expression);
    setDraft(appended.spec);
    setSelectedIndex(appended.spec.series.length - 1);
    updateKeyboardFocus("series");
    setExpression(formatSeriesExpression(appended.series));
    clearQuickAddInput();
    deactivateQuickAdd();
    quickAddRef.current?.blur?.();
    setError(null);
  };

  const submitQuickAdd = () => {
    addCatalogSuggestion(quickAddSuggestions[clampIndex(quickAddSelection, quickAddSuggestions.length)]);
  };

  const leaveQuickAdd = () => {
    deactivateQuickAdd();
    quickAddRef.current?.blur?.();
    setError(null);
  };

  const removeSeries = () => {
    if (!selected || draft.series.length <= 1) return;
    setDraft((current) => pruneSpec({
      ...current,
      series: current.series.filter((_, index) => index !== selectedIndex),
    }));
    setSelectedIndex((current) => clampIndex(current, draft.series.length - 1));
    setError(null);
  };

  const moveSeries = (delta: -1 | 1) => {
    if (!selected) return;
    const target = selectedIndex + delta;
    if (target < 0 || target >= draft.series.length) return;
    setDraft((current) => ({ ...current, series: moveAt(current.series, selectedIndex, delta) }));
    setSelectedIndex(target);
  };

  const beginExpressionEdit = () => {
    if (!selected) return;
    updateKeyboardFocus("source");
    deactivateQuickAdd();
    setEditingExpression(true);
    queueMicrotask(() => expressionRef.current?.focus?.());
  };

  const setSelectedPanel = (panelId: string) => {
    if (!selected || !draft.panels.some((panel) => panel.id === panelId)) return;
    updateSelected((series) => ({ ...series, panelId }));
  };

  const addPanel = () => {
    if (!selected) return;
    const used = new Set(draft.panels.map((panel) => panel.id));
    let index = 2;
    while (used.has(`panel-${index}`)) index += 1;
    const id = `panel-${index}`;
    setDraft((current) => ({
      ...current,
      panels: [...current.panels, { id, label: `Panel ${index}`, height: 0.35, scale: "linear" }],
      series: replaceAt(current.series, selectedIndex, { ...current.series[selectedIndex]!, panelId: id }),
    }));
  };

  const cyclePanel = () => {
    if (!selected || draft.panels.length === 0) return;
    const index = draft.panels.findIndex((panel) => panel.id === selected.panelId);
    setSelectedPanel(draft.panels[(index + 1) % draft.panels.length]?.id ?? "main");
  };

  const setSelectedPanelScale = (scale: PanelScale) => {
    if (!selected) return;
    setDraft((current) => ({
      ...current,
      panels: current.panels.map((panel) => panel.id === selected.panelId ? { ...panel, scale } : panel),
      series: scale === "log"
        ? current.series.map((series) => series.panelId === selected.panelId && series.transform === "log"
          ? { ...series, transform: "raw" }
          : series)
        : current.series,
    }));
  };

  const setSelectedTransform = (transform: SeriesTransform) => {
    if (!selected) return;
    setDraft((current) => ({
      ...current,
      panels: transform === "log"
        ? current.panels.map((panel) => panel.id === selected.panelId ? { ...panel, scale: "linear" } : panel)
        : current.panels,
      series: replaceAt(current.series, selectedIndex, (() => {
        const currentSeries = current.series[selectedIndex]!;
        const ohlcStyle = currentSeries.style === "candles" || currentSeries.style === "ohlc" || currentSeries.style === "hlc";
        return {
          ...currentSeries,
          style: transform !== "raw" && ohlcStyle
            ? getCompatibleSeriesStyles(seriesFieldId(currentSeries)).find((style) => style === "line" || style === "area") ?? "line"
            : currentSeries.style,
          transform,
        };
      })()),
    }));
  };

  const setSelectedStyle = (style: SeriesStyle) => {
    updateSelected((series) => applySeriesStyle(series, style));
  };

  const setSelectedTimestampMode = (timestampMode: SeriesTimestampMode) => {
    updateSelected((series) => applySeriesTimestampMode(series, timestampMode));
  };

  const setSelectedVisibility = (visible: boolean) => {
    if (!selected) return;
    setDraft((current) => {
      const target = current.series[selectedIndex];
      if (!target || (!visible && !canToggleChartSeries(current, target.id))) return current;
      return {
        ...current,
        series: replaceAt(current.series, selectedIndex, { ...target, visible }),
      };
    });
  };

  const saveDraft = () => {
    const next = pruneSpec(draft);
    const validation = validateChartSpec(next);
    if (!validation.valid) {
      setError(validation.errors.map((issue) => issue.message).join(" "));
      return;
    }
    resolve(next);
  };

  const toggleSelectedPanelScale = () => {
    const panel = selected ? draft.panels.find((entry) => entry.id === selected.panelId) : null;
    setSelectedPanelScale(panel?.scale === "log" ? "linear" : "log");
  };

  useDialogKeyboard((event) => {
    if (isDesktop && (event.targetEditable === true || event.name === "tab")) {
      if (event.name === "escape") {
        event.stopPropagation();
        event.preventDefault();
        resolve(null);
      }
      return;
    }

    if ((isDesktop && quickAddActive) || (!isDesktop && keyboardFocusRef.current === "add")) {
      const printableSequence = (
        !event.ctrl
        && !event.alt
        && !event.meta
        && !event.super
        && event.sequence
        && [...event.sequence].length === 1
        && event.sequence >= " "
      );
      if (isPlainKey(event, "up")) {
        event.stopPropagation();
        event.preventDefault();
        setQuickAddSelection((current) => clampIndex(current - 1, quickAddSuggestions.length));
      } else if (isPlainKey(event, "down")) {
        event.stopPropagation();
        event.preventDefault();
        setQuickAddSelection((current) => clampIndex(current + 1, quickAddSuggestions.length));
      } else if (event.name === "enter" || event.name === "return") {
        event.stopPropagation();
        event.preventDefault();
        submitQuickAdd();
      } else if (event.name === "escape") {
        event.stopPropagation();
        event.preventDefault();
        resolve(null);
      } else if (event.name === "tab") {
        event.stopPropagation();
        event.preventDefault();
        leaveQuickAdd();
        moveKeyboardFocus(event.shift ? -1 : 1);
      } else if (
        event.targetEditable !== true
        && printableSequence
      ) {
        event.stopPropagation();
        event.preventDefault();
        const nextQuery = `${quickAddRef.current?.editBuffer.getText() ?? quickAddQuery}${event.sequence}`;
        quickAddRef.current?.editBuffer.setText?.(nextQuery);
        quickAddRef.current?.setCursorOffset?.(nextQuery.length);
        setQuickAddQuery(nextQuery);
        activateQuickAdd();
        quickAddRef.current?.focus?.();
      }
      return;
    }

    if ((isDesktop && editingExpression) || (!isDesktop && keyboardFocusRef.current === "source")) {
      if (event.name === "escape") {
        event.stopPropagation();
        event.preventDefault();
        resolve(null);
      } else if (event.name === "enter" || event.name === "return") {
        event.stopPropagation();
        event.preventDefault();
        if (commitExpression()) moveKeyboardFocus(1);
      } else if (event.name === "tab") {
        event.stopPropagation();
        event.preventDefault();
        if (commitExpression()) moveKeyboardFocus(event.shift ? -1 : 1);
      }
      return;
    }

    event.stopPropagation();
    event.preventDefault();
    if (event.name === "tab") {
      moveKeyboardFocus(event.shift ? -1 : 1);
    } else if (keyboardFocusRef.current === "series" && isPlainKey(event, "up", "k")) {
      setSelectedIndex((current) => clampIndex(current - 1, draft.series.length));
    } else if (keyboardFocusRef.current === "series" && isPlainKey(event, "down", "j")) {
      setSelectedIndex((current) => clampIndex(current + 1, draft.series.length));
    } else if (event.name === "[") {
      moveSeries(-1);
    } else if (event.name === "]") {
      moveSeries(1);
    } else if (event.name === "a") {
      beginQuickAdd(true);
    } else if (event.name === "d" || event.name === "delete") {
      removeSeries();
    } else if (event.name === "e") {
      beginExpressionEdit();
    } else if (event.name === "p") {
      cyclePanel();
    } else if (event.name === "n") {
      addPanel();
    } else if (event.name === "l") {
      toggleSelectedPanelScale();
    } else if (event.name === "enter" || event.name === "return") {
      saveDraft();
    } else if (event.name === "escape") {
      resolve(null);
    }
  }, { scope: dialogId, allowEditable: true });

  const items = useMemo<ListViewItem[]>(() => draft.series.map((series) => ({
    id: series.id,
    label: chartSeriesLabel(series),
    description: [
      titleCaseSeriesEditorValue(series.style),
      timingDescription(series),
      titleCaseSeriesEditorValue(series.transform),
      `${titleCaseSeriesEditorValue(series.axis)} axis`,
      series.panelId,
    ].filter(Boolean).join(" · "),
  })), [draft.series]);
  const quickAddItems = useMemo<ListViewItem[]>(() => quickAddSuggestions.map((suggestion) => ({
    id: suggestion.id,
    label: suggestion.label,
    description: suggestion.description,
    detail: suggestion.detail,
  })), [quickAddSuggestions]);
  const fields = buildSeriesEditorFields({
    draft,
    selected,
    handlers: {
      setStyle: setSelectedStyle,
      setTransform: setSelectedTransform,
      setAxis: (axis) => updateSelected((series) => ({ ...series, axis })),
      setVisibility: setSelectedVisibility,
      setPanel: setSelectedPanel,
      addPanel,
      setScale: setSelectedPanelScale,
      setPeriod: (period) => updateSelected((series) => series.source.kind === "security" ? ({
        ...series,
        source: { ...series.source, period },
      }) : series),
      setTimestampMode: setSelectedTimestampMode,
    },
  });
  const actions = buildSeriesEditorActions({
    draft,
    selected,
    selectedIndex,
    handlers: {
      add: () => beginQuickAdd(true),
      remove: removeSeries,
      moveUp: () => moveSeries(-1),
      moveDown: () => moveSeries(1),
      cancel: () => resolve(null),
      save: saveDraft,
    },
  });

  return {
    actions,
    activateQuickAdd,
    addCatalogSuggestion,
    beginExpressionEdit,
    beginQuickAdd,
    commitExpression,
    deactivateQuickAdd,
    defaultInstrument,
    editingExpression,
    error,
    expression,
    expressionRef,
    fields,
    focusKeyboardTarget,
    items,
    keyboardFocus,
    moveKeyboardFocus,
    quickAddActive,
    quickAddItems,
    quickAddLoading,
    quickAddQuery,
    quickAddRef,
    quickAddSelection,
    quickAddSuggestions,
    selected,
    selectedIndex,
    setEditingExpression,
    setExpression,
    setQuickAddQuery,
    setQuickAddSelection,
    setSelectedIndex,
    submitQuickAdd,
    updateKeyboardFocus,
  };
}
