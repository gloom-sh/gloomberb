import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { Box, useUiCapabilities, type ScrollBoxRenderable } from "../ui";
import { isPlainKeyboardEvent } from "../utils/keyboard";

function listenToScrollBarChange(
  scrollBar: ScrollBoxRenderable["verticalScrollBar"],
  handler: () => void,
): (() => void) | null {
  if (
    !scrollBar
    || typeof scrollBar.on !== "function"
    || typeof scrollBar.off !== "function"
  ) {
    return null;
  }

  scrollBar.on("change", handler);
  return () => scrollBar.off?.("change", handler);
}

export interface TableViewKeyEvent {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  super?: boolean;
  alt?: boolean;
  option?: boolean;
  shift?: boolean;
  readonly defaultPrevented?: boolean;
  readonly propagationStopped?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export interface TableViewFrameProps {
  width?: number;
  height?: number;
  backgroundColor?: string;
  before?: ReactNode;
  after?: ReactNode;
  children: ReactNode;
}

export function TableViewFrame({
  width,
  height,
  backgroundColor,
  before,
  after,
  children,
}: TableViewFrameProps) {
  const { nativePaneChrome } = useUiCapabilities();
  const nativeFlexibleFrame = nativePaneChrome === true;

  return (
    <Box
      flexDirection="column"
      flexGrow={nativeFlexibleFrame || height == null ? 1 : undefined}
      flexShrink={nativeFlexibleFrame ? 1 : height == null ? undefined : 0}
      flexBasis={nativeFlexibleFrame ? 0 : undefined}
      width={width}
      height={nativeFlexibleFrame ? undefined : height}
      minWidth={nativeFlexibleFrame ? 0 : undefined}
      minHeight={nativeFlexibleFrame ? 0 : undefined}
      maxHeight={nativeFlexibleFrame ? "100%" : undefined}
      backgroundColor={backgroundColor}
      overflow="hidden"
      data-gloom-role="table-view-frame"
    >
      {before}
      {children}
      {after}
    </Box>
  );
}

export function isTableActivationKey(name: string | undefined): boolean {
  return name === "enter" || name === "return";
}

function getTableKeyName(event: TableViewKeyEvent | string | undefined): string | undefined {
  return typeof event === "string" ? event : event?.name;
}

function isPlainTableKey(event: TableViewKeyEvent | string | undefined): boolean {
  return typeof event !== "object" || isPlainKeyboardEvent(event);
}

export function isNextTableRowKey(event: TableViewKeyEvent | string | undefined): boolean {
  const name = getTableKeyName(event);
  if (!isPlainTableKey(event)) return false;
  return name === "j" || name === "down";
}

export function isPreviousTableRowKey(event: TableViewKeyEvent | string | undefined): boolean {
  const name = getTableKeyName(event);
  if (!isPlainTableKey(event)) return false;
  return name === "k" || name === "up";
}

export function stopTableKey(event: TableViewKeyEvent) {
  event.stopPropagation?.();
  event.preventDefault?.();
}

export function useTableViewState({
  headerScrollRef,
  scrollRef,
  syncHeaderScroll,
}: {
  headerScrollRef?: RefObject<ScrollBoxRenderable | null>;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  syncHeaderScroll?: () => void;
}) {
  const internalHeaderScrollRef = useRef<ScrollBoxRenderable>(null);
  const internalScrollRef = useRef<ScrollBoxRenderable>(null);

  const effectiveHeaderScrollRef = headerScrollRef ?? internalHeaderScrollRef;
  const effectiveScrollRef = scrollRef ?? internalScrollRef;

  const defaultSyncHeaderScroll = useCallback(() => {
    const body = effectiveScrollRef.current;
    const header = effectiveHeaderScrollRef.current;
    if (!body || !header) return;
    if (header.scrollLeft !== body.scrollLeft) {
      header.scrollLeft = body.scrollLeft;
    }
  }, [effectiveHeaderScrollRef, effectiveScrollRef]);

  return {
    effectiveHeaderScrollRef,
    effectiveScrollRef,
    effectiveSyncHeaderScroll: syncHeaderScroll ?? defaultSyncHeaderScroll,
  };
}

export function isTableScrollNearEnd(
  scrollBox: {
    scrollTop: number;
    scrollHeight: number;
    viewport?: { height: number } | null;
  } | null,
  threshold = 8,
): boolean {
  if (!scrollBox?.viewport) return false;
  const viewportHeight = Math.max(1, scrollBox.viewport.height);
  return scrollBox.scrollTop + viewportHeight >= scrollBox.scrollHeight - threshold;
}

export function useTableLoadMore(
  scrollRef: RefObject<ScrollBoxRenderable | null>,
  canLoadMore: boolean,
  loadMore: () => void,
  threshold = 8,
) {
  return useCallback(() => {
    if (!canLoadMore) return;
    if (!isTableScrollNearEnd(scrollRef.current, threshold)) return;
    loadMore();
  }, [canLoadMore, loadMore, scrollRef, threshold]);
}

export function useTableBodyScrollActivity({
  onBodyScrollActivity,
  syncHeaderScroll,
  afterScroll,
}: {
  onBodyScrollActivity?: () => void;
  syncHeaderScroll: () => void;
  afterScroll?: () => void;
}) {
  return useCallback(() => {
    if (onBodyScrollActivity) {
      onBodyScrollActivity();
    } else {
      queueMicrotask(syncHeaderScroll);
    }
    if (afterScroll) {
      queueMicrotask(afterScroll);
    }
  }, [afterScroll, onBodyScrollActivity, syncHeaderScroll]);
}

export function useScrollBoxScrollActivity({
  scrollRef,
  onVerticalScroll,
  onHorizontalScroll,
}: {
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onVerticalScroll?: () => void;
  onHorizontalScroll?: () => void;
}) {
  const onVerticalScrollRef = useRef(onVerticalScroll);
  const onHorizontalScrollRef = useRef(onHorizontalScroll);
  const verticalScrollScheduledRef = useRef(false);
  const horizontalScrollScheduledRef = useRef(false);

  useEffect(() => {
    onVerticalScrollRef.current = onVerticalScroll;
    onHorizontalScrollRef.current = onHorizontalScroll;
  }, [onHorizontalScroll, onVerticalScroll]);

  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (!scrollBox) return;
    let active = true;

    const handleVerticalChange = () => {
      if (verticalScrollScheduledRef.current) return;
      verticalScrollScheduledRef.current = true;
      queueMicrotask(() => {
        verticalScrollScheduledRef.current = false;
        if (!active) return;
        onVerticalScrollRef.current?.();
      });
    };
    const handleHorizontalChange = () => {
      if (horizontalScrollScheduledRef.current) return;
      horizontalScrollScheduledRef.current = true;
      queueMicrotask(() => {
        horizontalScrollScheduledRef.current = false;
        if (!active) return;
        onHorizontalScrollRef.current?.();
      });
    };

    const removeVerticalListener = listenToScrollBarChange(
      scrollBox.verticalScrollBar,
      handleVerticalChange,
    );
    const removeHorizontalListener = listenToScrollBarChange(
      scrollBox.horizontalScrollBar,
      handleHorizontalChange,
    );

    return () => {
      active = false;
      removeVerticalListener?.();
      removeHorizontalListener?.();
    };
  }, [scrollRef]);
}

export function useResetTableScroll({
  headerScrollRef,
  scrollRef,
  resetScrollKey,
  afterReset,
}: {
  headerScrollRef: RefObject<ScrollBoxRenderable | null>;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  resetScrollKey?: unknown;
  afterReset?: () => void;
}) {
  const afterResetRef = useRef(afterReset);

  useEffect(() => {
    afterResetRef.current = afterReset;
  }, [afterReset]);

  useEffect(() => {
    if (resetScrollKey === undefined) return;
    const body = scrollRef.current;
    if (body) {
      body.scrollTop = 0;
      body.scrollLeft = 0;
    }
    const header = headerScrollRef.current;
    if (header) {
      header.scrollLeft = 0;
    }
    if (afterResetRef.current) {
      queueMicrotask(afterResetRef.current);
    }
  }, [headerScrollRef, resetScrollKey, scrollRef]);
}
