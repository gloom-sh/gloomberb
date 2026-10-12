import { useCallback, useSyncExternalStore, type RefObject } from "react";
import { buildAskGloomPaneAttachment } from "../../../../ask-gloom/pane-context";
import {
  askGloomAboutPane,
  canAskGloomAboutPanes,
  subscribeAskGloomAboutPanes,
} from "../../../../ask-gloom/pane-request";
import { domPaneText, terminalPaneText, type CellRect } from "../../../../ask-gloom/pane-text";
import type { DockLeafLayout, FloatingRect, LayoutBounds, ResolvedPane } from "../../../../layout/pane-manager";
import type { PluginRegistry } from "../../../../plugins/registry";
import { useRemoteUiRegistry, type RemoteUiRegistry } from "../../../../remote/semantic-tree";
import type { AppState } from "../../../../state/app/context";
import type { LayoutConfig } from "../../../../types/config";
import { useNativeRenderer } from "../../../../ui";
import { readRenderableBounds } from "../cursor-occlusion";
import { personalDataContext } from "./personal-data";

interface ShellPaneAskOptions {
  focusedPaneId: string | null;
  getPaneTitle: (pane: ResolvedPane) => string;
  /** The layout the panes are in, for their `personalData` rules. */
  layout: LayoutConfig;
  nativePaneChrome: boolean;
  paneMap: Map<string, ResolvedPane>;
  pluginRegistry: PluginRegistry;
  /** What is on screen: in fullscreen, the one pane filling the area. */
  screenDockLeafLayouts: DockLeafLayout[];
  screenFloatingPanes: Array<{ pane: ResolvedPane; rect: FloatingRect }>;
  /** The shell's box: where the pane area starts on the terminal's screen. */
  shellRef: RefObject<unknown>;
  stateRef: RefObject<AppState>;
}

export interface AskAboutPaneOptions {
  /** Terminal: a surface drawn over the pane when it was asked from, such as its menu. */
  cover?: LayoutBounds | null;
}

const DEFAULT_FLOATING_Z = 50;

/**
 * The tab each strip of the pane has open, outermost first: on the desktop the
 * primary strip sits in the header, the rest are in the body with the
 * terminal's, where the semantic tree names their pane.
 */
function activePaneTabs(paneId: string, remoteUi: RemoteUiRegistry | null, nativePaneChrome: boolean): string[] {
  const tabs: string[] = [];
  if (nativePaneChrome) {
    const doc = (globalThis as { document?: Document }).document;
    const header = doc?.querySelector(`[data-gloom-pane-id="${paneId.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"] [data-gloom-role=pane-header-tabs]`);
    const selected = header?.querySelector("[role=tab][aria-selected=true]")?.textContent?.trim();
    if (selected) tabs.push(selected);
  }
  try {
    for (const node of remoteUi?.snapshot() ?? []) {
      if (node.paneId !== paneId || node.role !== "tabs") continue;
      const metadata = node.metadata as { activeValue?: unknown; tabs?: Array<{ value?: unknown; label?: unknown }> } | undefined;
      const label = metadata?.tabs?.find((tab) => tab.value === metadata.activeValue)?.label;
      if (typeof label === "string" && label.trim() && !tabs.includes(label.trim())) tabs.push(label.trim());
    }
  } catch {
    // A node that fails to describe itself leaves the tab out.
  }
  return tabs;
}

/**
 * Ask Gloom about a pane, from its header button, its menu or the pane-ask
 * key: describes the pane (its function and arguments, and its text as drawn
 * now) and hands it to Ask Gloom. Offered only while Ask Gloom takes it.
 */
export function useShellPaneAsk({
  focusedPaneId,
  getPaneTitle,
  layout,
  nativePaneChrome,
  paneMap,
  pluginRegistry,
  screenDockLeafLayouts,
  screenFloatingPanes,
  shellRef,
  stateRef,
}: ShellPaneAskOptions) {
  const canAsk = useSyncExternalStore(subscribeAskGloomAboutPanes, canAskGloomAboutPanes, canAskGloomAboutPanes);
  const nativeRenderer = useNativeRenderer();
  const remoteUi = useRemoteUiRegistry();

  const readTerminalText = useCallback((paneId: string, cover: LayoutBounds | null | undefined): string | null => {
    const frame = nativeRenderer.captureFrame?.();
    if (!frame) return null;
    const docked = screenDockLeafLayouts.find((leaf) => leaf.instanceId === paneId);
    const floatingIndex = screenFloatingPanes.findIndex(({ pane }) => pane.instance.instanceId === paneId);
    const rect = docked?.rect ?? screenFloatingPanes[floatingIndex]?.rect;
    if (!rect) return null;
    const z = (index: number) => screenFloatingPanes[index]?.pane.floating?.zIndex ?? DEFAULT_FLOATING_Z;
    // Floating panes over this one: every one over a docked pane, the higher ones over a floating pane.
    const covered: CellRect[] = screenFloatingPanes
      .filter((_, index) => index !== floatingIndex && (docked || z(index) > z(floatingIndex) || (z(index) === z(floatingIndex) && index > floatingIndex)))
      .map((entry) => entry.rect);
    if (cover) covered.push(cover);
    const shell = readRenderableBounds(shellRef.current);
    return terminalPaneText(frame, rect, { offsetX: shell?.x ?? 0, offsetY: shell?.y ?? 0, covered });
  }, [nativeRenderer, screenDockLeafLayouts, screenFloatingPanes, shellRef]);

  const askAboutPane = useCallback((paneId: string, options: AskAboutPaneOptions = {}): boolean => {
    if (!canAskGloomAboutPanes()) return false;
    const pane = paneMap.get(paneId);
    if (!pane) return false;
    const state = stateRef.current;
    let visibleText: string | null = null;
    try {
      visibleText = nativePaneChrome ? domPaneText(paneId) : readTerminalText(paneId, options.cover);
    } catch {
      visibleText = null;
    }
    const attachment = buildAskGloomPaneAttachment({
      registry: pluginRegistry,
      def: pane.def,
      context: personalDataContext(state, layout, pane),
      title: getPaneTitle(pane),
      activeTabs: activePaneTabs(paneId, remoteUi, nativePaneChrome),
      visibleText,
    });
    return askGloomAboutPane(attachment);
  }, [getPaneTitle, layout, nativePaneChrome, paneMap, pluginRegistry, readTerminalText, remoteUi, stateRef]);

  const askAboutFocusedPane = useCallback(
    () => (focusedPaneId ? askAboutPane(focusedPaneId) : false),
    [askAboutPane, focusedPaneId],
  );

  return { canAsk, askAboutPane, askAboutFocusedPane };
}
