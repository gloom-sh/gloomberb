import { cloneLayout, createBlankLayout, type SavedLayout } from "../../../types/config";
import {
  clonePaneStateMap,
  cloneSavedLayout,
  historyForIndex,
  moveHistoryIndex,
  movedIndex,
  removeHistoryIndex,
  setHistoryForIndex,
  syncConfigActiveLayoutState,
  withFocusedPane,
} from "./layout";
import type { AppAction, AppState } from "./types";

const MAX_LAYOUT_HISTORY = 50;

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
        state.activePanel,
      );
      const target = currentConfig.layouts[action.index]!;
      return withFocusedPane(state, {
        ...currentConfig,
        layout: cloneLayout(target.layout),
        activeLayoutIndex: action.index,
      }, {
        paneState: target.paneState ? clonePaneStateMap(target.paneState) : {},
        focusedPaneId: target.focusedPaneId ?? null,
        activePanel: target.activePanel ?? state.activePanel,
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
        state.activePanel,
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
        state.activePanel,
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

    case "DELETE_LAYOUT": {
      if (state.config.layouts.length <= 1) return state;
      const currentConfig = syncConfigActiveLayoutState(
        state.config,
        state.paneState,
        state.focusedPaneId,
        state.activePanel,
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
        activePanel: nextLayout.activePanel ?? state.activePanel,
      });
    }

    case "RENAME_LAYOUT": {
      if (action.index < 0 || action.index >= state.config.layouts.length) return state;
      const currentConfig = syncConfigActiveLayoutState(
        state.config,
        state.paneState,
        state.focusedPaneId,
        state.activePanel,
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
        state.activePanel,
      );
      const source = currentConfig.layouts[action.index]!;
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
        activePanel: duplicate.activePanel ?? state.activePanel,
      });
    }

    default:
      return undefined;
  }
}
