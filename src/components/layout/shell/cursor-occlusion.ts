import { useEffect, useRef, type RefObject } from "react";
import { useNativeRenderer, type NativeCursorState, type NativePostProcessFn } from "../../../ui";
import type { FloatingRect, LayoutBounds, ResolvedPane } from "../../../layout/pane-manager";
import { constrainFloatingRectToBounds } from "./drag";

interface VisibleFloatingPane {
  pane: ResolvedPane;
  rect: FloatingRect;
}

export interface ShellCursorOcclusionRect extends LayoutBounds {
  paneId: string;
  zIndex: number;
}

interface ResolveShellCursorOcclusionRectsOptions {
  contentHeight: number;
  dragFloatingRect: { paneId: string; rect: FloatingRect } | null;
  nativePaneChrome: boolean;
  overlayOpen: boolean;
  transientFocusActive: boolean;
  visibleFloatingPanes: readonly VisibleFloatingPane[];
  width: number;
}

const MAX_RENDERABLE_ANCESTOR_DEPTH = 256;

export function resolveShellCursorOcclusionRects({
  contentHeight,
  dragFloatingRect,
  nativePaneChrome,
  overlayOpen,
  transientFocusActive,
  visibleFloatingPanes,
  width,
}: ResolveShellCursorOcclusionRectsOptions): ShellCursorOcclusionRect[] {
  if (nativePaneChrome || overlayOpen || transientFocusActive || visibleFloatingPanes.length === 0) {
    return [];
  }

  return visibleFloatingPanes.map(({ pane, rect }) => {
    const paneId = pane.instance.instanceId;
    const visibleRect = dragFloatingRect?.paneId === paneId
      ? constrainFloatingRectToBounds(dragFloatingRect.rect, width, contentHeight)
      : rect;
    return {
      paneId,
      zIndex: pane.floating?.zIndex ?? 50,
      x: Math.floor(visibleRect.x),
      y: Math.floor(visibleRect.y),
      width: Math.max(0, Math.ceil(visibleRect.width)),
      height: Math.max(0, Math.ceil(visibleRect.height)),
    };
  });
}

function readRenderableBounds(renderable: unknown): LayoutBounds | null {
  if (!renderable || typeof renderable !== "object") return null;
  const record = renderable as Record<string, unknown>;
  const getRect = record.getBoundingClientRect;
  if (typeof getRect === "function") {
    const rect = getRect.call(renderable) as Partial<LayoutBounds> | null | undefined;
    if (
      rect
      && typeof rect.x === "number"
      && typeof rect.y === "number"
      && typeof rect.width === "number"
      && typeof rect.height === "number"
    ) {
      return rect as LayoutBounds;
    }
  }

  const absoluteBounds = record.absoluteBounds as Partial<LayoutBounds> | null | undefined;
  if (
    absoluteBounds
    && typeof absoluteBounds.x === "number"
    && typeof absoluteBounds.y === "number"
    && typeof absoluteBounds.width === "number"
    && typeof absoluteBounds.height === "number"
  ) {
    return absoluteBounds as LayoutBounds;
  }

  const x = typeof record.screenX === "number"
    ? record.screenX
    : typeof record.absoluteX === "number"
      ? record.absoluteX
      : typeof record.x === "number"
        ? record.x
        : null;
  const y = typeof record.screenY === "number"
    ? record.screenY
    : typeof record.absoluteY === "number"
      ? record.absoluteY
      : typeof record.y === "number"
        ? record.y
        : null;
  const width = typeof record.width === "number" ? record.width : null;
  const height = typeof record.height === "number" ? record.height : null;
  if (x == null || y == null || width == null || height == null) return null;
  return { x, y, width, height };
}

function readRenderablePaneId(renderable: unknown): string | null {
  let current = renderable;
  const seen = new Set<object>();
  let depth = 0;

  while (current && typeof current === "object" && !seen.has(current)) {
    if (depth >= MAX_RENDERABLE_ANCESTOR_DEPTH) return null;
    seen.add(current);
    depth += 1;
    const record = current as Record<string, unknown>;
    const paneId = record["data-gloom-pane-id"];
    if (typeof paneId === "string") return paneId;
    current = record.parent;
  }
  return null;
}

function rectContainsCursor(rect: LayoutBounds, cursor: NativeCursorState): boolean {
  return cursor.x >= rect.x
    && cursor.x < rect.x + rect.width
    && cursor.y >= rect.y
    && cursor.y < rect.y + rect.height;
}

function toTerminalRect(shellBounds: LayoutBounds, rect: ShellCursorOcclusionRect): ShellCursorOcclusionRect {
  return {
    ...rect,
    x: Math.floor(shellBounds.x + rect.x + 1),
    y: Math.floor(shellBounds.y + rect.y + 1),
  };
}

function resolveCursorOwnerZIndex(
  cursorOwnerPaneId: string | null,
  rects: readonly ShellCursorOcclusionRect[],
): number {
  if (!cursorOwnerPaneId) return Number.NEGATIVE_INFINITY;
  return rects.find((rect) => rect.paneId === cursorOwnerPaneId)?.zIndex ?? 0;
}

function shouldHideCursor({
  cursor,
  cursorOwnerPaneId,
  terminalRects,
}: {
  cursor: NativeCursorState;
  cursorOwnerPaneId: string | null;
  terminalRects: readonly ShellCursorOcclusionRect[];
}): boolean {
  const ownerZIndex = resolveCursorOwnerZIndex(cursorOwnerPaneId, terminalRects);
  return terminalRects.some((rect) => {
    if (rect.paneId === cursorOwnerPaneId) return false;
    if (rect.zIndex <= ownerZIndex) return false;
    return rectContainsCursor(rect, cursor);
  });
}

export function useShellCursorOcclusionGuard({
  resolveOcclusionRects,
  shellRef,
}: {
  /** Called on every terminal frame. */
  resolveOcclusionRects: () => readonly ShellCursorOcclusionRect[];
  shellRef: RefObject<unknown>;
}) {
  const nativeRenderer = useNativeRenderer();
  const stateRef = useRef({ resolveOcclusionRects, shellRef });
  stateRef.current = { resolveOcclusionRects, shellRef };

  useEffect(() => {
    if (
      !nativeRenderer.addPostProcessFn
      || !nativeRenderer.removePostProcessFn
      || !nativeRenderer.getCursorState
      || !nativeRenderer.setCursorPosition
    ) {
      return;
    }

    const guardCursor: NativePostProcessFn = () => {
      const cursor = nativeRenderer.getCursorState?.();
      if (!cursor?.visible) return;
      const shellBounds = readRenderableBounds(stateRef.current.shellRef.current);
      if (!shellBounds) return;

      const terminalRects = stateRef.current.resolveOcclusionRects().map((rect) => toTerminalRect(shellBounds, rect));
      if (terminalRects.length === 0) return;

      const cursorOwnerPaneId = readRenderablePaneId(nativeRenderer.currentFocusedEditor);
      if (!shouldHideCursor({ cursor, cursorOwnerPaneId, terminalRects })) return;
      nativeRenderer.setCursorPosition?.(0, 0, false);
    };

    nativeRenderer.addPostProcessFn(guardCursor);
    nativeRenderer.requestRender();
    return () => {
      nativeRenderer.removePostProcessFn?.(guardCursor);
      nativeRenderer.requestRender();
    };
  }, [nativeRenderer]);
}
