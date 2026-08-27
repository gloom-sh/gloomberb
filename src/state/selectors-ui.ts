import type { AppState } from "../core/state/app/state";
import type { LayoutConfig, SavedLayout } from "../types/config";
import type { ReleaseInfo, UpdateProgress } from "../updater";

export function selectLayout(state: AppState): LayoutConfig {
  return state.config.layout;
}

export function selectFocusedPaneId(state: AppState): string | null {
  return state.focusedPaneId;
}

export function selectCommandBarOpen(state: AppState): boolean {
  return state.commandBarOpen;
}

export function selectStatusBarVisible(state: AppState): boolean {
  return state.statusBarVisible;
}

export function selectBaseCurrency(state: AppState): string {
  return state.config.baseCurrency;
}

export function selectSavedLayouts(state: AppState): SavedLayout[] {
  return state.config.layouts;
}

export function selectActiveLayoutIndex(state: AppState): number {
  return state.config.activeLayoutIndex;
}

export function selectUpdateAvailable(state: AppState): ReleaseInfo | null {
  return state.updateAvailable;
}

export function selectUpdateProgress(state: AppState): UpdateProgress | null {
  return state.updateProgress;
}

export function selectUpdateCheckInProgress(state: AppState): boolean {
  return state.updateCheckInProgress;
}

export function selectUpdateNotice(state: AppState): string | null {
  return state.updateNotice;
}
