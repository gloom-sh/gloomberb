import { getDockedPaneIds } from "../layout/pane-manager";
import type { AppState } from "../state/app/context";
import type { LayoutConfig, PaneInstanceConfig } from "../types/config";
import { revisionFor } from "./revision";
import type { RemoteControlResponse, RemoteIncludedState, RemoteStateInclude } from "./types";

export interface PatchTarget<T> {
  value: T;
  apply(value: T): Promise<void> | void;
}

export function ok<T>(data: T, rev?: string, state?: RemoteIncludedState): RemoteControlResponse<T> {
  return {
    ok: true,
    data,
    ...(rev ? { rev } : {}),
    ...(state ? { state } : {}),
  };
}

export function fail(code: string, error: unknown): RemoteControlResponse {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberInput(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`);
  }
  return value as number;
}

export function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return Number.isInteger(value) ? value as number : undefined;
}

export function activeLayoutRev(state: AppState): string {
  return revisionFor({
    layout: state.config.layout,
    paneState: state.paneState,
    focusedPaneId: state.focusedPaneId,
  });
}

function panePlacement(layout: LayoutConfig, instanceId: string): "docked" | "floating" | "detached" | "hidden" {
  if (getDockedPaneIds(layout).includes(instanceId)) return "docked";
  if (layout.floating.some((entry) => entry.instanceId === instanceId)) return "floating";
  if ((layout.detached ?? []).some((entry) => entry.instanceId === instanceId)) return "detached";
  return "hidden";
}

export function paneSnapshot(state: AppState, pane: PaneInstanceConfig) {
  return {
    ...pane,
    placement: panePlacement(state.config.layout, pane.instanceId),
    focused: state.focusedPaneId === pane.instanceId,
    runtimeState: state.paneState[pane.instanceId] ?? {},
  };
}

export function mutationSummary(state: AppState, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    rev: activeLayoutRev(state),
    activeLayoutIndex: state.config.activeLayoutIndex,
    activeLayoutName: state.config.layouts[state.config.activeLayoutIndex]?.name ?? null,
    focusedPaneId: state.focusedPaneId,
    commandBarOpen: state.commandBarOpen,
    commandBarQuery: state.commandBarQuery,
    dockedPaneIds: getDockedPaneIds(state.config.layout),
    floatingPaneIds: state.config.layout.floating.map((entry) => entry.instanceId),
    detachedPaneIds: (state.config.layout.detached ?? []).map((entry) => entry.instanceId),
    ...extra,
  };
}

export function normalizeIncludes(
  include: RemoteStateInclude[] | undefined,
  defaults: RemoteStateInclude[] = [],
): RemoteStateInclude[] {
  const raw = include ?? defaults;
  if (raw.includes("all")) {
    return ["app", "layout", "panes", "commandBar", "ui", "schema", "help"];
  }
  return [...new Set(raw)];
}
