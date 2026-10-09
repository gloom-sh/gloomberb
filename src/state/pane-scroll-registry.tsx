import { useImperativeHandle, useLayoutEffect, useRef, type ForwardedRef, type RefObject } from "react";
import { useShortcut } from "../react/input";
import { useNativeRenderer, type ScrollBoxRenderable } from "../ui/host";
import { useAppSelector, useOptionalPaneInstanceId } from "./app/context";

type ScrollDirection = "up" | "down";

/** A scroll position: rows (or cells), or device pixels where the host measures in them. */
type ScrollTarget = { cells: number } | { pixels: number };

interface PaneScrollAction {
  direction: ScrollDirection;
  resolveTarget(scrollBox: ScrollBoxRenderable): ScrollTarget | null;
}

interface PaneScrollEntry {
  order: number;
  ref: RefObject<ScrollBoxRenderable | null>;
  onScrollActivity?: (event: { scroll: { direction: ScrollDirection; delta: number } }) => void;
}

interface PaneScrollKeyEvent {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  option?: boolean;
  shift?: boolean;
  defaultPrevented?: boolean;
  propagationStopped?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

const paneScrollBoxes = new Map<string, Map<number, PaneScrollEntry>>();
let nextScrollEntryId = 1;
let nextScrollEntryOrder = 1;
const MIN_ARROW_SCROLL_LINES = 3;

function hasHiddenAncestor(scrollBox: ScrollBoxRenderable): boolean {
  let node: unknown = scrollBox;
  const seen = new Set<unknown>();

  while (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const renderable = node as { visible?: unknown; parent?: unknown };
    if (renderable.visible === false) return true;
    node = renderable.parent;
  }

  return false;
}

function hasCollapsedBounds(scrollBox: ScrollBoxRenderable): boolean {
  const bounds = scrollBox.getBoundingClientRect?.();
  return bounds != null && (bounds.width <= 0 || bounds.height <= 0);
}

function isVisibleScrollBox(scrollBox: ScrollBoxRenderable): boolean {
  return !hasHiddenAncestor(scrollBox) && !hasCollapsedBounds(scrollBox);
}

function maxScrollTop(scrollBox: ScrollBoxRenderable): number {
  const viewportHeight = Math.max(0, scrollBox.viewport?.height ?? 0);
  if (viewportHeight <= 0) return 0;
  return Math.max(0, scrollBox.scrollHeight - viewportHeight);
}

/**
 * The desktop host rounds its viewport and content to whole rows, which can
 * leave up to half a row of content past the last scrollable row. Where it
 * also reports pixels, the ends are measured in them.
 */
function pixelRange(scrollBox: ScrollBoxRenderable): { top: number; max: number } | null {
  const { scrollTopPx, scrollHeightPx, viewportPx } = scrollBox;
  if (!scrollBox.scrollToPixels || typeof scrollTopPx !== "number" || typeof scrollHeightPx !== "number" || !viewportPx) {
    return null;
  }
  return { top: scrollTopPx, max: Math.max(0, scrollHeightPx - viewportPx.height) };
}

function topTarget(scrollBox: ScrollBoxRenderable): ScrollTarget | null {
  if ((scrollBox.viewport?.height ?? 0) <= 0) return null;
  const pixels = pixelRange(scrollBox);
  if (pixels) return pixels.top >= 1 ? { pixels: 0 } : null;
  return scrollBox.scrollTop > 0 ? { cells: 0 } : null;
}

function bottomTarget(scrollBox: ScrollBoxRenderable): ScrollTarget | null {
  const max = maxScrollTop(scrollBox);
  // A body that overflows by less than a row is not worth capturing the keys for.
  if (max <= 0) return null;
  const pixels = pixelRange(scrollBox);
  if (pixels) return pixels.max - pixels.top >= 1 ? { pixels: pixels.max } : null;
  return max !== scrollBox.scrollTop ? { cells: max } : null;
}

function scrollTargetByDelta(scrollBox: ScrollBoxRenderable, delta: number): ScrollTarget | null {
  if ((scrollBox.viewport?.height ?? 0) <= 0) return null;
  const wanted = scrollBox.scrollTop + delta;
  if (delta < 0 && wanted <= 0) return topTarget(scrollBox);
  if (delta > 0 && wanted >= maxScrollTop(scrollBox)) return bottomTarget(scrollBox);
  return delta === 0 ? null : { cells: wanted };
}

function applyScrollTarget(scrollBox: ScrollBoxRenderable, target: ScrollTarget): void {
  if ("pixels" in target) {
    scrollBox.scrollToPixels?.(target.pixels);
    return;
  }
  scrollBox.scrollTo(target.cells);
  if (scrollBox.scrollTop !== target.cells) {
    scrollBox.scrollTop = target.cells;
  }
}

/**
 * Moves a scroll box by whole lines, kept within its content. For bodies that
 * step one line per key, where the pane scroll keys would move a quarter page.
 */
export function scrollByLines(scrollBox: ScrollBoxRenderable, delta: number): void {
  const target = scrollTargetByDelta(scrollBox, delta);
  if (target) applyScrollTarget(scrollBox, target);
}

function arrowScrollLines(scrollBox: ScrollBoxRenderable): number {
  return Math.max(MIN_ARROW_SCROLL_LINES, Math.floor((scrollBox.viewport?.height ?? 0) / 4));
}

function resolveKeyScrollAction(event: PaneScrollKeyEvent): PaneScrollAction | null {
  if (event.ctrl || event.meta || event.alt || event.option) return null;
  // j and k scroll a plain body as the arrows do; a list that moves a cursor
  // on them has already used the key by the time this runs.
  const name = !event.shift && event.name === "j" ? "down" : !event.shift && event.name === "k" ? "up" : event.name;

  switch (name) {
    case "down":
      return {
        direction: "down",
        resolveTarget: (scrollBox) => scrollTargetByDelta(scrollBox, arrowScrollLines(scrollBox)),
      };
    case "up":
      return {
        direction: "up",
        resolveTarget: (scrollBox) => scrollTargetByDelta(scrollBox, -arrowScrollLines(scrollBox)),
      };
    case "pagedown":
      return {
        direction: "down",
        resolveTarget: (scrollBox) => scrollTargetByDelta(
          scrollBox,
          Math.max(1, (scrollBox.viewport?.height ?? 1) - 1),
        ),
      };
    case "pageup":
      return {
        direction: "up",
        resolveTarget: (scrollBox) => scrollTargetByDelta(
          scrollBox,
          -Math.max(1, (scrollBox.viewport?.height ?? 1) - 1),
        ),
      };
    case "home":
      return { direction: "up", resolveTarget: topTarget };
    case "end":
      return { direction: "down", resolveTarget: bottomTarget };
    default:
      return null;
  }
}

function getEntryScore(entry: PaneScrollEntry, scrollBox: ScrollBoxRenderable): number {
  const viewportHeight = scrollBox.viewport?.height ?? 0;
  const scrollHeight = scrollBox.scrollHeight;
  return viewportHeight * 100_000 + Math.min(scrollHeight, 99_999) + entry.order / 100_000;
}

function findScrollableEntry(paneId: string, action: PaneScrollAction): {
  entry: PaneScrollEntry;
  scrollBox: ScrollBoxRenderable;
  target: ScrollTarget;
} | null {
  const entries = paneScrollBoxes.get(paneId);
  if (!entries) return null;

  let best: { entry: PaneScrollEntry; scrollBox: ScrollBoxRenderable; target: ScrollTarget; score: number } | null = null;
  for (const entry of entries.values()) {
    const scrollBox = entry.ref.current;
    if (!scrollBox) continue;
    if (!isVisibleScrollBox(scrollBox)) continue;

    const target = action.resolveTarget(scrollBox);
    if (target == null) continue;

    const score = getEntryScore(entry, scrollBox);
    if (!best || score > best.score) {
      best = { entry, scrollBox, target, score };
    }
  }

  if (!best) return null;
  return { entry: best.entry, scrollBox: best.scrollBox, target: best.target };
}

function scrollPaneByKey(paneId: string, event: PaneScrollKeyEvent): boolean {
  const action = resolveKeyScrollAction(event);
  if (!action) return false;

  const match = findScrollableEntry(paneId, action);
  if (!match) return false;

  const { scrollBox } = match;
  const position = () => scrollBox.scrollTopPx ?? scrollBox.scrollTop;
  const previousTop = scrollBox.scrollTop;
  const previousPosition = position();
  applyScrollTarget(scrollBox, match.target);

  if (position() === previousPosition) return false;
  const delta = Math.max(1, Math.abs(scrollBox.scrollTop - previousTop));
  match.entry.onScrollActivity?.({ scroll: { direction: action.direction, delta } });
  return true;
}

export function useForwardedScrollBoxRef<T>(
  forwardedRef: ForwardedRef<T>,
): RefObject<T | null> {
  const localRef = useRef<T | null>(null);
  useImperativeHandle(forwardedRef, () => localRef.current as T);
  return localRef;
}

export function useRegisterPaneScrollBox(
  ref: RefObject<ScrollBoxRenderable | null>,
  options: {
    enabled: boolean;
    onScrollActivity?: PaneScrollEntry["onScrollActivity"];
  },
): void {
  const paneId = useOptionalPaneInstanceId();
  const entryIdRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!paneId || !options.enabled) return;

    const entryId = nextScrollEntryId++;
    entryIdRef.current = entryId;
    let entries = paneScrollBoxes.get(paneId);
    if (!entries) {
      entries = new Map();
      paneScrollBoxes.set(paneId, entries);
    }
    entries.set(entryId, {
      order: nextScrollEntryOrder++,
      ref,
      onScrollActivity: options.onScrollActivity,
    });

    return () => {
      const currentEntries = paneScrollBoxes.get(paneId);
      currentEntries?.delete(entryId);
      if (currentEntries?.size === 0) {
        paneScrollBoxes.delete(paneId);
      }
      if (entryIdRef.current === entryId) {
        entryIdRef.current = null;
      }
    };
  }, [paneId, options.enabled, options.onScrollActivity, ref]);
}

export function PaneKeyboardScrollController({
  paneId,
  focused,
}: {
  paneId: string;
  focused: boolean;
}) {
  const nativeRenderer = useNativeRenderer();
  const inputCaptured = useAppSelector((state) => state.inputCaptured);
  const focusedRef = useRef(focused);
  const inputCapturedRef = useRef(inputCaptured);
  const paneIdRef = useRef(paneId);

  focusedRef.current = focused;
  inputCapturedRef.current = inputCaptured;
  paneIdRef.current = paneId;

  useShortcut((event) => {
    if (!focusedRef.current || inputCapturedRef.current) return;
    if (event.defaultPrevented || event.propagationStopped) return;
    if (!scrollPaneByKey(paneIdRef.current, event)) return;

    event.preventDefault();
    event.stopPropagation();
    nativeRenderer.requestRender();
  }, { phase: "after" });

  return null;
}
