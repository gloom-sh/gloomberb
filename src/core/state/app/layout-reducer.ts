import { cloneLayout, createBlankLayout, getPlacedPaneInstanceIds, type SavedLayout } from "../../../types/config";
import { movePaneBack, movePaneToOwnLayout, paneMoveBackTarget } from "../../../layout/pane-layout-move";
import {
  clonePaneStateMap,
  cloneSavedLayout,
  historyForIndex,
  moveHistoryIndex,
  movedIndex,
  removeHistoryIndex,
  resolveTickerForPane,
  setHistoryForIndex,
  syncConfigActiveLayoutState,
  withFocusedPane,
} from "./layout";
import type { AppAction, AppState, PaneRuntimeState } from "./types";

const MAX_LAYOUT_HISTORY = 50;

function availableLayoutName(name: string, layouts: SavedLayout[]): string {
  const base = name.trim() || "Community Layout";
  const existing = new Set(layouts.map((layout) => layout.name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (existing.has(`${base} (${suffix})`.toLowerCase())) suffix += 1;
  return `${base} (${suffix})`;
}

export function reduceLayoutAction(state: AppState, action: AppAction): AppState | undefined {
  switch (action.type) {
    case "PUSH_LAYOUT_HISTORY": {
      const currentIndex = state.config.activeLayoutIndex;
      const entry = historyForIndex(state.layoutHistory, currentIndex);
      const snapshot = cloneLayout(state.config.layout);
      const last = entry.past[entry.past.length - 1];
      if (last && JSON.stringify(last) === JSON.stringify(snapshot)) {
        return state;
      }
      entry.past = [...entry.past, snapshot].slice(-MAX_LAYOUT_HISTORY);
      entry.future = [];
      return {
        ...state,
        layoutHistory: setHistoryForIndex(state.layoutHistory, currentIndex, entry),
      };
    }

    case "UNDO_LAYOUT": {
      const currentIndex = state.config.activeLayoutIndex;
      const entry = historyForIndex(state.layoutHistory, currentIndex);
      if (entry.past.length === 0) return state;
      const target = entry.past[entry.past.length - 1]!;
      entry.past = entry.past.slice(0, -1);
      entry.future = [cloneLayout(state.config.layout), ...entry.future].slice(0, MAX_LAYOUT_HISTORY);
      return withFocusedPane({
        ...state,
        layoutHistory: setHistoryForIndex(state.layoutHistory, currentIndex, entry),
      }, {
        ...state.config,
        layout: cloneLayout(target),
      });
    }

    case "REDO_LAYOUT": {
      const currentIndex = state.config.activeLayoutIndex;
      const entry = historyForIndex(state.layoutHistory, currentIndex);
      if (entry.future.length === 0) return state;
      const target = entry.future[0]!;
      entry.future = entry.future.slice(1);
      entry.past = [...entry.past, cloneLayout(state.config.layout)].slice(-MAX_LAYOUT_HISTORY);
      return withFocusedPane({
        ...state,
        layoutHistory: setHistoryForIndex(state.layoutHistory, currentIndex, entry),
      }, {
        ...state.config,
        layout: cloneLayout(target),
      });
    }

    case "UPDATE_LAYOUT":
      return withFocusedPane(
        state,
        { ...state.config, layout: action.layout },
        Object.prototype.hasOwnProperty.call(action, "focusedPaneId")
          ? { focusedPaneId: action.focusedPaneId ?? null }
          : {},
      );

    case "SWITCH_LAYOUT": {
      if (action.index < 0 || action.index >= state.config.layouts.length) return state;
      if (action.index === state.config.activeLayoutIndex) return state;
      const currentConfig = syncConfigActiveLayoutState(
        state.config,
        state.paneState,
        state.focusedPaneId,
      );
      const target = currentConfig.layouts[action.index]!;
      return withFocusedPane(state, {
        ...currentConfig,
        layout: cloneLayout(target.layout),
        activeLayoutIndex: action.index,
      }, {
        paneState: target.paneState ? clonePaneStateMap(target.paneState) : {},
        focusedPaneId: target.focusedPaneId ?? null,
      });
    }

    case "REORDER_LAYOUT": {
      const { fromIndex, toIndex } = action;
      if (
        fromIndex === toIndex
        || fromIndex < 0
        || toIndex < 0
        || fromIndex >= state.config.layouts.length
        || toIndex >= state.config.layouts.length
      ) return state;

      const currentConfig = syncConfigActiveLayoutState(
        state.config,
        state.paneState,
        state.focusedPaneId,
      );
      const layouts = [...currentConfig.layouts];
      const [movedLayout] = layouts.splice(fromIndex, 1);
      if (!movedLayout) return state;
      layouts.splice(toIndex, 0, movedLayout);

      return {
        ...state,
        config: {
          ...currentConfig,
          layouts,
          activeLayoutIndex: movedIndex(currentConfig.activeLayoutIndex, fromIndex, toIndex),
        },
        layoutHistory: moveHistoryIndex(state.layoutHistory, fromIndex, toIndex),
      };
    }

    case "NEW_LAYOUT": {
      const currentConfig = syncConfigActiveLayoutState(
        state.config,
        state.paneState,
        state.focusedPaneId,
      );
      const newLayout: SavedLayout = {
        name: action.name,
        layout: createBlankLayout(),
        paneState: {},
      };
      const layouts = [...currentConfig.layouts, newLayout];
      return withFocusedPane({
        ...state,
        layoutHistory: setHistoryForIndex(state.layoutHistory, layouts.length - 1, { past: [], future: [] }),
      }, {
        ...currentConfig,
        layout: cloneLayout(newLayout.layout),
        layouts,
        activeLayoutIndex: layouts.length - 1,
      }, {
        paneState: {},
        focusedPaneId: null,
      });
    }

    case "INSTALL_LAYOUT_COPY": {
      const currentConfig = syncConfigActiveLayoutState(
        state.config,
        state.paneState,
        state.focusedPaneId,
      );
      const installed: SavedLayout = {
        name: availableLayoutName(action.name, currentConfig.layouts),
        layout: cloneLayout(action.layout),
        paneState: clonePaneStateMap(action.paneState),
        ...(action.origin ? { origin: action.origin } : {}),
      };
      const layouts = [...currentConfig.layouts, installed];
      return withFocusedPane({
        ...state,
        layoutHistory: setHistoryForIndex(state.layoutHistory, layouts.length - 1, { past: [], future: [] }),
      }, {
        ...currentConfig,
        layout: cloneLayout(installed.layout),
        layouts,
        activeLayoutIndex: layouts.length - 1,
      }, {
        paneState: clonePaneStateMap(installed.paneState ?? {}),
        focusedPaneId: null,
      });
    }

    case "DELETE_LAYOUT": {
      if (state.config.layouts.length <= 1) return state;
      const currentConfig = syncConfigActiveLayoutState(
        state.config,
        state.paneState,
        state.focusedPaneId,
      );
      const layouts = currentConfig.layouts.filter((_, index) => index !== action.index);
      const nextActiveLayoutIndex = action.index <= state.config.activeLayoutIndex
        ? Math.max(0, state.config.activeLayoutIndex - 1)
        : state.config.activeLayoutIndex;
      const nextLayout = layouts[nextActiveLayoutIndex]!;
      return withFocusedPane({
        ...state,
        layoutHistory: removeHistoryIndex(state.layoutHistory, action.index),
      }, {
        ...currentConfig,
        layout: cloneLayout(nextLayout.layout),
        layouts,
        activeLayoutIndex: nextActiveLayoutIndex,
      }, {
        paneState: nextLayout.paneState ? clonePaneStateMap(nextLayout.paneState) : {},
        focusedPaneId: nextLayout.focusedPaneId ?? null,
      });
    }

    case "SET_LAYOUT_ORIGIN": {
      if (action.index < 0 || action.index >= state.config.layouts.length) return state;
      const currentConfig = syncConfigActiveLayoutState(
        state.config,
        state.paneState,
        state.focusedPaneId,
      );
      return {
        ...state,
        config: {
          ...currentConfig,
          layouts: currentConfig.layouts.map((savedLayout, index) => {
            if (index !== action.index) return savedLayout;
            const { origin: _origin, ...rest } = savedLayout;
            return action.origin ? { ...rest, origin: action.origin } : rest;
          }),
        },
      };
    }

    case "REPLACE_LAYOUT_CONTENT": {
      if (action.index < 0 || action.index >= state.config.layouts.length) return state;
      const currentConfig = syncConfigActiveLayoutState(
        state.config,
        state.paneState,
        state.focusedPaneId,
      );
      const replaced: SavedLayout = {
        ...currentConfig.layouts[action.index]!,
        ...(action.name ? { name: action.name } : {}),
        layout: cloneLayout(action.layout),
        paneState: clonePaneStateMap(action.paneState),
        focusedPaneId: null,
        origin: action.origin,
      };
      const layouts = currentConfig.layouts.map((savedLayout, index) => (
        index === action.index ? replaced : savedLayout
      ));
      // Pulled content replaces what the tab shows, so its undo history is
      // no longer about this content.
      const nextState = {
        ...state,
        layoutHistory: setHistoryForIndex(state.layoutHistory, action.index, { past: [], future: [] }),
      };
      if (action.index !== currentConfig.activeLayoutIndex) {
        return { ...nextState, config: { ...currentConfig, layouts } };
      }
      return withFocusedPane(nextState, {
        ...currentConfig,
        layout: cloneLayout(replaced.layout),
        layouts,
      }, {
        paneState: clonePaneStateMap(replaced.paneState ?? {}),
        focusedPaneId: null,
      });
    }

    case "RENAME_LAYOUT": {
      if (action.index < 0 || action.index >= state.config.layouts.length) return state;
      const currentConfig = syncConfigActiveLayoutState(
        state.config,
        state.paneState,
        state.focusedPaneId,
      );
      return {
        ...state,
        config: {
          ...currentConfig,
          layouts: currentConfig.layouts.map((savedLayout, index) => (
            index === action.index ? { ...savedLayout, name: action.name } : savedLayout
          )),
        },
      };
    }

    case "DUPLICATE_LAYOUT": {
      if (action.index < 0 || action.index >= state.config.layouts.length) return state;
      const currentConfig = syncConfigActiveLayoutState(
        state.config,
        state.paneState,
        state.focusedPaneId,
      );
      const { id: _id, ...source } = currentConfig.layouts[action.index]!;
      // A copy is a layout of its own: sharing the id would send Move Back to either.
      const duplicate: SavedLayout = {
        ...cloneSavedLayout(source),
        name: `${source.name} Copy`,
      };
      const layouts = [...currentConfig.layouts, duplicate];
      return withFocusedPane({
        ...state,
        layoutHistory: setHistoryForIndex(state.layoutHistory, layouts.length - 1, { past: [], future: [] }),
      }, {
        ...currentConfig,
        layout: cloneLayout(duplicate.layout),
        layouts,
        activeLayoutIndex: layouts.length - 1,
      }, {
        paneState: duplicate.paneState ? clonePaneStateMap(duplicate.paneState) : {},
        focusedPaneId: duplicate.focusedPaneId ?? state.focusedPaneId,
      });
    }

    case "MOVE_PANE_TO_NEW_LAYOUT": {
      const resolveSymbol = (instanceId: string) => resolveTickerForPane(state, instanceId);
      const currentConfig = syncConfigActiveLayoutState(state.config, state.paneState, state.focusedPaneId);
      const sourceIndex = currentConfig.activeLayoutIndex;
      const sourceEntry = currentConfig.layouts[sourceIndex]!;
      const sourceLayoutId = sourceEntry.id ?? action.sourceLayoutId;
      const move = movePaneToOwnLayout(state.config.layout, action.paneId, sourceLayoutId, resolveSymbol);
      if (!move) return state;

      const { [action.paneId]: savedPaneState, ...sourcePaneState } = sourceEntry.paneState ?? {};
      // The live object, so the pane's state keeps its identity across the move.
      const livePaneState = (state.paneState[action.paneId] ?? savedPaneState) as PaneRuntimeState | undefined;
      const movedPaneState: Record<string, PaneRuntimeState> = livePaneState ? { [action.paneId]: livePaneState } : {};
      const previous = state.previousFocusedPaneId;
      const sourceFocus = previous && getPlacedPaneInstanceIds(move.source).includes(previous) ? previous : null;
      const layouts: SavedLayout[] = currentConfig.layouts.map((entry, index) => (
        index === sourceIndex
          ? { ...entry, id: sourceLayoutId, layout: move.source, paneState: sourcePaneState, focusedPaneId: sourceFocus }
          : entry
      ));
      layouts.push({
        name: availableLayoutName(action.name, layouts),
        layout: move.target,
        paneState: movedPaneState,
        focusedPaneId: action.paneId,
      });
      return withFocusedPane({
        ...state,
        layoutHistory: setHistoryForIndex(state.layoutHistory, layouts.length - 1, { past: [], future: [] }),
      }, {
        ...currentConfig,
        layout: cloneLayout(move.target),
        layouts,
        activeLayoutIndex: layouts.length - 1,
      }, {
        paneState: movedPaneState,
        focusedPaneId: action.paneId,
      });
    }

    case "MOVE_PANE_BACK": {
      const target = paneMoveBackTarget(state.config, action.paneId);
      if (!target) return state;
      const resolveSymbol = (instanceId: string) => resolveTickerForPane(state, instanceId);
      const currentConfig = syncConfigActiveLayoutState(state.config, state.paneState, state.focusedPaneId);
      const activeIndex = currentConfig.activeLayoutIndex;
      const activeEntry = currentConfig.layouts[activeIndex]!;
      const targetEntry = currentConfig.layouts[target.index]!;
      const move = movePaneBack(state.config.layout, targetEntry.layout, action.paneId, target.original, resolveSymbol);
      if (!move) return state;

      const { [action.paneId]: savedPaneState, ...activePaneState } = activeEntry.paneState ?? {};
      const livePaneState = (state.paneState[action.paneId] ?? savedPaneState) as PaneRuntimeState | undefined;
      const { [action.paneId]: _stale, ...targetPaneState } = targetEntry.paneState ?? {};
      if (livePaneState) targetPaneState[action.paneId] = livePaneState;
      let layouts: SavedLayout[] = currentConfig.layouts.map((entry, index) => {
        if (index === target.index) return { ...entry, layout: move.target, paneState: targetPaneState, focusedPaneId: action.paneId };
        if (index === activeIndex) return { ...entry, layout: move.source, paneState: activePaneState, focusedPaneId: null };
        return entry;
      });
      // A layout the pane leaves empty was only there for it, unless a team layout is linked to it.
      let layoutHistory = state.layoutHistory;
      let nextIndex = target.index;
      if (getPlacedPaneInstanceIds(move.source).length === 0 && !activeEntry.origin) {
        layouts = layouts.filter((_, index) => index !== activeIndex);
        layoutHistory = removeHistoryIndex(layoutHistory, activeIndex);
        if (activeIndex < target.index) nextIndex -= 1;
      }
      const next = layouts[nextIndex]!;
      return withFocusedPane({ ...state, layoutHistory }, {
        ...currentConfig,
        layout: cloneLayout(next.layout),
        layouts,
        activeLayoutIndex: nextIndex,
      }, {
        paneState: {
          ...clonePaneStateMap(targetPaneState),
          ...(livePaneState ? { [action.paneId]: livePaneState } : {}),
        },
        focusedPaneId: action.paneId,
      });
    }

    default:
      return undefined;
  }
}
