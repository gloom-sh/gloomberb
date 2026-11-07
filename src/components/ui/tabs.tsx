import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { usePaneMenuItems, usePaneTabStripKeys } from "../layout/pane/footer/registration";
import type { ContextMenuItem } from "../../types/context-menu";
import { useShortcut } from "../../react/input";
import { Box, ScrollBox, Text, useNativeRenderer, useUiHost } from "../../ui";
import { TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "../../ui";
import { hoverBg } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { t } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { displayWidth } from "../../utils/format";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { capturePointerDrag } from "../../ui/pointer-drag";
import { observeScrollBoxContentSize, observeScrollBoxViewportSize } from "../../renderers/opentui/scrollbox-layout";

type TabPointerEvent = {
  button?: number;
  preventDefault: () => void;
  stopPropagation?: () => void;
};

interface TabItem {
  label: string;
  value: string;
  /**
   * Artwork before the label on the desktop and the web, such as the logo of
   * the broker a portfolio's account is at (`LogoMark`). It is decoration: the
   * terminal does not draw it, and automation and screen readers read only
   * `label`. Keep the same element between renders (useMemo): a title-bar
   * strip redraws when it changes.
   */
  leading?: ReactNode;
  /**
   * The key that switches to this tab, where `label` starts with it (`⌘1 ` of
   * `⌘1 Research`). The desktop and the web hide it on a touch screen, which
   * has no keys to press it with, as they hide keycaps; the terminal draws the
   * label as it is.
   */
  keyPrefix?: string;
  disabled?: boolean;
  /** Text color while inactive; used for group markers such as a team accent. */
  fg?: string;
  reorderable?: boolean;
  onClose?: (value: string) => void;
  onDoubleClick?: (value: string) => void;
  onContextMenu?: (value: string, event: TabPointerEvent) => void;
}

export interface TabsProps {
  tabs: TabItem[];
  activeValue: string | null;
  onSelect: (value: string) => void;
  compact?: boolean;
  dense?: boolean;
  /** `header` is the desktop title-bar strip drawn by the pane chrome (see usePaneHeaderTabs). */
  variant?: "underline" | "pill" | "bare" | "header";
  closeMode?: "active" | "always";
  addLabel?: string;
  onAdd?: () => void;
  onReorder?: (fromValue: string, toValue: string) => void;
  /** A press that moves, on a tab that is not reordered. Desktop title-bar tabs use it to move the window. */
  onDrag?: () => void;
  focused?: boolean;
  keyboardNavigation?: boolean;
  /**
   * Lists New/Close/Move Tab in the pane menu while focused. Turn it off when
   * the pane already offers the same actions as footer hints.
   */
  paneMenu?: boolean;
  scrollable?: boolean;
  scrollId?: string;
  /**
   * The surface the strip sits on (the status bar's panel, a pane's title
   * bar): the cells the strip draws over its tabs, the edge markers, are
   * painted with it. The app's background by default.
   */
  background?: string;
}

const WHEEL_DELTA_PER_CELL = 8;

/** A pane re-renders on each quote; its tab strip only when the tabs or their state change. */
export const Tabs = memo(TabsView);

function TabsView({
  tabs: rawTabs,
  activeValue,
  onSelect,
  compact = false,
  dense = false,
  variant = "underline",
  closeMode = "always",
  addLabel = "+",
  onAdd,
  onReorder,
  onDrag,
  focused: paneFocused = false,
  keyboardNavigation = true,
  paneMenu = true,
  scrollable = true,
  scrollId,
  background,
}: TabsProps) {
  // While a chart the user moved into holds the keys, the strip draws as
  // unfocused, so it shows where the arrows went.
  const stripKeys = usePaneTabStripKeys(keyboardNavigation, paneFocused);
  const focused = paneFocused && !stripKeys.held;
  const language = useAppLanguage();
  const colors = useThemeColors();
  const tabs = useMemo(() => rawTabs.map((tab) => (
    { ...tab, label: t(tab.label) }
  )), [language, rawTabs]);
  const ui = useUiHost();
  const NativeTabs = ui.Tabs;
  const navigationValueRef = useRef<string | null>(activeValue);
  const renderedActiveValueRef = useRef<string | null>(activeValue);
  if (renderedActiveValueRef.current !== activeValue) {
    renderedActiveValueRef.current = activeValue;
    navigationValueRef.current = activeValue;
  }
  const palette = {
    activeFg: focused || variant === "bare" ? colors.textBright : colors.text,
    inactiveFg: colors.textDim,
    disabledFg: colors.textMuted,
    hoverFg: colors.text,
    activeUnderline: focused ? colors.textBright : colors.borderFocused,
    inactiveUnderline: colors.bg,
    hoverUnderline: colors.border,
    hoverBg: hoverBg(colors),
    activeBg: colors.selected,
    activePillFg: colors.selectedText,
    closeFg: colors.textMuted,
    addFg: colors.textMuted,
    bg: background ?? colors.bg,
  };
  const handleSelect = useCallback((value: string) => {
    navigationValueRef.current = value;
    onSelect(value);
  }, [onSelect]);
  useRemoteUiNode({
    role: "tabs",
    label: "Tabs",
    actions: {
      select: (input) => {
        const value = resolveTabValue(input, tabs);
        if (!value) return;
        const tab = tabs.find((entry) => entry.value === value);
        if (!tab || tab.disabled) return;
        handleSelect(value);
      },
      add: onAdd ? () => onAdd() : undefined,
      close: (input) => {
        const value = resolveTabValue(input, tabs);
        if (!value) return;
        const tab = tabs.find((entry) => entry.value === value);
        if (!tab || tab.disabled) return;
        tab.onClose?.(value);
      },
    },
    metadata: {
      activeValue,
      tabs: tabs.map((tab) => ({
        label: tab.label,
        value: tab.value,
        disabled: tab.disabled === true,
        closeable: !!tab.onClose,
      })),
    },
  });

  // Adding, closing and moving tabs by pointer have pane menu entries while the
  // strip is focused, so a keyboard reaches them without per-pane keys. The
  // entries read the handlers and neighbours when chosen, never a stale copy.
  const menuRegistrationId = `tabs:${useId()}`;
  const latestTabs = useRef({ tabs, activeValue, onAdd, onReorder });
  latestTabs.current = { tabs, activeValue, onAdd, onReorder };
  const activeTab = tabs.find((tab) => tab.value === activeValue);
  const activeIndex = activeTab ? tabs.indexOf(activeTab) : -1;
  const canMove = (offset: -1 | 1) => {
    const neighbour = tabs[activeIndex + offset];
    return !!onReorder && !!activeTab && activeTab.reorderable !== false && !!neighbour && neighbour.reorderable !== false;
  };
  const moveActive = (offset: -1 | 1) => {
    const current = latestTabs.current;
    const index = current.tabs.findIndex((tab) => tab.value === current.activeValue);
    const neighbour = current.tabs[index + offset];
    if (index >= 0 && neighbour) current.onReorder?.(current.tabs[index]!.value, neighbour.value);
  };
  const canMoveLeft = canMove(-1);
  const canMoveRight = canMove(1);
  const canClose = !!activeTab?.onClose && !activeTab.disabled;
  usePaneMenuItems(menuRegistrationId, () => {
    if (!focused || !paneMenu) return null;
    const items: ContextMenuItem[] = [];
    if (onAdd) {
      items.push({
        id: "tab-add",
        label: addLabel && addLabel !== "+" ? addLabel : t("New Tab"),
        onSelect: () => latestTabs.current.onAdd?.(),
      });
    }
    if (canClose) {
      items.push({
        id: "tab-close",
        label: t("Close Tab"),
        onSelect: () => {
          const current = latestTabs.current;
          const tab = current.tabs.find((entry) => entry.value === current.activeValue);
          if (tab && !tab.disabled) tab.onClose?.(tab.value);
        },
      });
    }
    if (canMoveLeft) items.push({ id: "tab-move-left", label: t("Move Tab Left"), onSelect: () => moveActive(-1) });
    if (canMoveRight) items.push({ id: "tab-move-right", label: t("Move Tab Right"), onSelect: () => moveActive(1) });
    return items;
  }, [addLabel, canClose, canMoveLeft, canMoveRight, focused, paneMenu, !!onAdd]);

  const selectAdjacentTab = useCallback((direction: -1 | 1) => {
    const enabledTabs = tabs.filter((tab) => !tab.disabled);
    if (enabledTabs.length === 0) return;

    const navigationValue = enabledTabs.some((tab) => tab.value === navigationValueRef.current)
      ? navigationValueRef.current
      : activeValue;
    const activeIndex = enabledTabs.findIndex((tab) => tab.value === navigationValue);
    const nextIndex = activeIndex >= 0
      ? Math.max(0, Math.min(activeIndex + direction, enabledTabs.length - 1))
      : direction > 0 ? 0 : enabledTabs.length - 1;
    const nextTab = enabledTabs[nextIndex];
    if (!nextTab || nextTab.value === navigationValue) return;
    handleSelect(nextTab.value);
  }, [activeValue, handleSelect, tabs]);

  useShortcut((event) => {
    // Shift+arrows scroll a wide table's columns; they never switch tabs.
    if (event.ctrl || event.meta || event.alt || event.shift || event.targetEditable) return;

    if (event.name === "h" || event.name === "left") {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentTab(-1);
      return;
    }
    if (event.name === "l" || event.name === "right") {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentTab(1);
    }
  }, { enabled: stripKeys.active });

  if (NativeTabs) {
    return (
      <NativeTabs
        tabs={tabs}
        activeValue={activeValue}
        onSelect={handleSelect}
        compact={compact}
        dense={dense}
        variant={variant}
        closeMode={closeMode}
        addLabel={addLabel}
        onAdd={onAdd}
        onReorder={onReorder}
        onDrag={onDrag}
        focused={focused}
        palette={palette}
      />
    );
  }

  return (
    <OpenTuiTabs
      tabs={tabs}
      activeValue={activeValue}
      onSelect={handleSelect}
      compact={compact}
      dense={dense}
      variant={variant}
      closeMode={closeMode}
      addLabel={addLabel}
      onAdd={onAdd}
      onReorder={onReorder}
      focused={focused}
      scrollable={scrollable}
      scrollId={scrollId}
      palette={palette}
    />
  );
}

function resolveTabValue(input: unknown, tabs: TabItem[]): string | null {
  if (typeof input === "string") return input;
  if (typeof input === "number") return tabs[input]?.value ?? null;
  if (input && typeof input === "object") {
    const value = input as { value?: unknown; label?: unknown; index?: unknown };
    if (typeof value.value === "string") return value.value;
    if (typeof value.label === "string") {
      return tabs.find((tab) => tab.label === value.label)?.value ?? null;
    }
    if (typeof value.index === "number") return tabs[value.index]?.value ?? null;
  }
  return null;
}

function tabWidth(
  tab: TabItem,
  active: boolean,
  closeMode: TabsProps["closeMode"],
  dense = false,
): number {
  const showClose = !!tab.onClose && (closeMode === "always" || active);
  return displayWidth(tab.label) + (dense ? 1 : 2) + (showClose ? 2 : 0);
}

function OpenTuiTabs({
  tabs,
  activeValue,
  onSelect,
  compact = false,
  dense = false,
  variant = "underline",
  closeMode = "always",
  addLabel = "+",
  onAdd,
  onReorder,
  focused = false,
  scrollable = true,
  scrollId,
  palette,
}: TabsProps & {
  palette: {
    activeFg: string;
    inactiveFg: string;
    disabledFg: string;
    hoverFg: string;
    activeUnderline: string;
    inactiveUnderline: string;
    hoverUnderline: string;
    hoverBg: string;
    activeBg: string;
    activePillFg: string;
    closeFg: string;
    addFg: string;
    bg: string;
  };
}) {
  const [hoveredValue, setHoveredValue] = useState<string | null>(null);
  const [dragTargetValue, setDragTargetValue] = useState<string | null>(null);
  const nativeRenderer = useNativeRenderer();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const tabRowRef = useRef<BoxRenderable>(null);
  const tabRefs = useRef(new Map<string, BoxRenderable>());
  const dragSourceValueRef = useRef<string | null>(null);
  const tabWidths = useMemo(
    () => tabs.map((tab) => tabWidth(tab, tab.value === activeValue, closeMode, dense)),
    [activeValue, closeMode, dense, tabs],
  );
  const addWidth = onAdd ? addLabel.length + (dense ? 1 : 2) : 0;
  const totalWidth = tabWidths.reduce((sum, width) => sum + width, 0) + addWidth;

  const resolveDragTarget = useCallback((event?: { x?: number; preciseX?: number }) => {
    const pointerX = event?.preciseX ?? event?.x;
    if (typeof pointerX !== "number") return null;

    let closestValue: string | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const tab of tabs) {
      if (tab.disabled || tab.reorderable === false) continue;
      const renderable = tabRefs.current.get(tab.value);
      const bounds = renderable?.absoluteBounds;
      const left = bounds?.x ?? renderable?.absoluteX ?? renderable?.x;
      const width = bounds?.width ?? renderable?.width;
      if (typeof left !== "number" || typeof width !== "number") continue;
      const right = left + width;
      const distance = pointerX < left ? left - pointerX : pointerX > right ? pointerX - right : 0;
      if (distance < closestDistance) {
        closestDistance = distance;
        closestValue = tab.value;
      }
    }
    return closestValue;
  }, [tabs]);

  const handleTabDrag = useCallback((event?: {
    x?: number;
    preciseX?: number;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) => {
    if (!dragSourceValueRef.current) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const targetValue = resolveDragTarget(event);
    setDragTargetValue((current) => (current === targetValue ? current : targetValue));
  }, [resolveDragTarget]);

  const finishTabDrag = useCallback((event?: {
    x?: number;
    preciseX?: number;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) => {
    const sourceValue = dragSourceValueRef.current;
    if (!sourceValue) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const targetValue = resolveDragTarget(event) ?? dragTargetValue;
    dragSourceValueRef.current = null;
    setDragTargetValue(null);
    if (targetValue && targetValue !== sourceValue) {
      onReorder?.(sourceValue, targetValue);
    }
  }, [dragTargetValue, onReorder, resolveDragTarget]);

  // Revealing the active tab must not fight a user who scrolled the strip to
  // look for another one. Callers rebuild the tab array on every render, and a
  // pane re-renders on every quote tick, so depending on those objects re-snaps
  // the viewport several times a second. Only a change of the active tab or of
  // the strip geometry is allowed to move it.
  const revealKey = `${activeValue ?? ""}|${tabs.map((tab, index) => `${tab.value}:${tabWidths[index]}`).join(",")}`;
  const revealRef = useRef({ tabWidths, totalWidth, activeIndex: -1, dense });
  revealRef.current = {
    tabWidths,
    totalWidth,
    activeIndex: tabs.findIndex((tab) => tab.value === activeValue),
    dense,
  };
  // Which edges of an overflowing strip hide tabs: each shows a marker, so a cut strip says there is more.
  const [edges, setEdges] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  // What the markers show, read before setting them: an unchanged strip schedules no render.
  const edgesRef = useRef(edges);
  const updateEdges = useCallback(() => {
    const scrollBox = scrollRef.current;
    const viewportWidth = scrollBox?.viewport?.width || scrollBox?.width || 0;
    const { totalWidth: stripWidth } = revealRef.current;
    const left = scrollBox?.scrollLeft ?? 0;
    const next = viewportWidth > 0
      ? { left: left > 0, right: left + viewportWidth < stripWidth }
      : { left: false, right: false };
    if (edgesRef.current.left === next.left && edgesRef.current.right === next.right) return;
    edgesRef.current = next;
    setEdges(next);
  }, []);
  // Blank cells after the last tab, so the strip can start at a tab's edge
  // when it reveals the last ones (see revealActiveTab).
  const [revealPad, setRevealPad] = useState(0);
  const revealPadRef = useRef(0);
  // The strip and tab last revealed, and a scroll the padding held back until it rendered.
  const revealedRef = useRef<{ geometry: string; pendingLeft: number | null }>({ geometry: "", pendingLeft: null });
  const revealActiveTab = useCallback(() => {
    const scrollBox = scrollRef.current;
    const { tabWidths: widths, totalWidth: stripWidth, activeIndex, dense: denseStrip } = revealRef.current;
    const viewportWidth = scrollBox?.viewport?.width || scrollBox?.width || 0;
    if (!scrollBox || activeIndex < 0 || viewportWidth <= 0) return;
    const geometry = `${activeIndex}|${viewportWidth}|${stripWidth}|${widths.join(",")}`;
    const revealed = revealedRef.current;
    if (revealed.geometry === geometry) {
      // The same tab in the same strip: only a scroll the padding held back is finished, once the padding has
      // rendered, never the user's own scroll undone.
      const left = revealed.pendingLeft;
      if (left != null) {
        scrollBox.scrollLeft = left;
        scrollBox.scrollTo({ x: left, y: scrollBox.scrollTop });
        if ((scrollBox.scrollLeft ?? 0) === left) revealed.pendingLeft = null;
      }
      return;
    }
    revealedRef.current = { geometry, pendingLeft: null };

    // A dense tab has no blank cell before its label: a strip scrolled to it starts on the blank after the tab before,
    // which the edge marker covers, never on the label's first letter.
    const edge = (start: number) => (denseStrip && start > 0 ? start - 1 : start);
    const activeLeft = edge(widths.slice(0, activeIndex).reduce((sum, width) => sum + width, 0));
    const activeRight = widths.slice(0, activeIndex + 1).reduce((sum, width) => sum + width, 0);
    const currentLeft = scrollBox.scrollLeft ?? 0;
    const currentRight = currentLeft + viewportWidth;
    const scrollToLeft = (left: number) => {
      scrollBox.scrollLeft = left;
      scrollBox.scrollTo({ x: left, y: scrollBox.scrollTop });
    };
    const padTo = (pad: number) => {
      if (pad === revealPadRef.current) return;
      revealPadRef.current = pad;
      setRevealPad(pad);
    };
    // Where each tab starts: a strip scrolled to between two of them shows the end of a label.
    const starts = widths.map((_, index) => edge(widths.slice(0, index).reduce((sum, width) => sum + width, 0)));
    const cutAtStart = currentLeft > 0 && !starts.includes(currentLeft);

    if (stripWidth <= viewportWidth) {
      padTo(0);
      if (currentLeft > 0) scrollToLeft(0);
    } else if (activeLeft < currentLeft) {
      padTo(0);
      scrollToLeft(activeLeft);
    } else if (activeRight > currentRight || cutAtStart) {
      // The tab revealed ends at the right edge with as many whole tabs before it as fit, the strip starting at a
      // tab's edge: the one before is shown whole or not at all, never as the end of its label. A tab wider than
      // the strip shows its start. Past the last tab the strip is padded with blank cells to scroll that far.
      let left = activeLeft;
      for (let index = activeIndex - 1; index >= 0 && activeRight - starts[index]! <= viewportWidth; index -= 1) left = starts[index]!;
      padTo(Math.max(0, left + viewportWidth - stripWidth));
      scrollToLeft(left);
      if ((scrollBox.scrollLeft ?? 0) !== left) revealedRef.current.pendingLeft = left;
    }
  }, []);
  const revealAndMark = useCallback(() => {
    revealActiveTab();
    updateEdges();
  }, [revealActiveTab, updateEdges]);
  useEffect(revealAndMark, [revealAndMark, revealKey]);
  // React effects can run before a floating pane's native viewport has its
  // new width. Retry after computed layout, preserving ScrollBox's range update.
  useEffect(() => observeScrollBoxViewportSize(scrollRef.current, revealAndMark), [revealAndMark, scrollable]);
  useEffect(() => observeScrollBoxContentSize(scrollRef.current, revealAndMark), [revealAndMark, scrollable]);

  /** Scrolls the strip a viewport's width toward an edge marker that was clicked, starting at a tab's edge. */
  const scrollToward = (direction: -1 | 1) => {
    const scrollBox = scrollRef.current;
    const viewportWidth = scrollBox?.viewport?.width || scrollBox?.width || 0;
    if (!scrollBox || viewportWidth <= 0) return;
    const starts = tabWidths.map((_, index) => tabWidths.slice(0, index).reduce((sum, width) => sum + width, 0))
      .map((start) => (dense && start > 0 ? start - 1 : start));
    const current = scrollBox.scrollLeft ?? 0;
    const maxLeft = Math.max(0, totalWidth + revealPadRef.current - viewportWidth);
    // Right: the first tab cut at the right edge starts the strip. Left: the strip ends where it started.
    const target = direction > 0
      ? starts.find((start, index) => start + tabWidths[index]! > current + viewportWidth) ?? maxLeft
      : starts.findLast((start) => start <= Math.max(0, current - viewportWidth)) ?? 0;
    const left = Math.max(0, Math.min(maxLeft, target));
    scrollBox.scrollLeft = left;
    scrollBox.scrollTo({ x: left, y: scrollBox.scrollTop });
    updateEdges();
  };

  const handleMouseScroll = (event?: {
    preventDefault?: () => void;
    stopPropagation?: () => void;
    scroll?: { direction?: string; delta?: number };
  }) => {
    const direction = event?.scroll?.direction;
    if (!direction) return;
    const scrollBox = scrollRef.current;
    const viewportWidth = scrollBox?.viewport?.width || scrollBox?.width || 0;
    if (!scrollBox || viewportWidth <= 0 || totalWidth <= viewportWidth) return;

    event.preventDefault?.();
    event.stopPropagation?.();

    const rawDelta = Math.abs(event.scroll?.delta ?? 1);
    const deltaCells = Math.max(1, Math.round(rawDelta / WHEEL_DELTA_PER_CELL));
    const directionSign = direction === "right" || direction === "down" ? 1 : -1;
    // As far as the reveal's blank cells past the last tab reach, so a tick never pulls a revealed strip off a tab's edge.
    const maxScrollLeft = Math.max(0, totalWidth + (scrollable ? revealPadRef.current : 0) - viewportWidth);
    const nextLeft = Math.max(
      0,
      Math.min(maxScrollLeft, (scrollBox.scrollLeft ?? 0) + directionSign * deltaCells),
    );
    scrollBox.scrollLeft = nextLeft;
    scrollBox.scrollTo({ x: nextLeft, y: scrollBox.scrollTop });
    updateEdges();
  };

  const tabRow = (
    <Box
      ref={tabRowRef}
      flexDirection="row"
      width={totalWidth + (scrollable ? revealPad : 0)}
      height={1}
      onMouseDrag={onReorder ? handleTabDrag : undefined}
      onMouseDragEnd={onReorder ? finishTabDrag : undefined}
    >
      {tabs.map((tab, index) => {
        const active = tab.value === activeValue;
        const hovered = (hoveredValue === tab.value || dragTargetValue === tab.value) && !tab.disabled;
        const focusedActive = focused && active;
        const tabWidth = tabWidths[index] ?? displayWidth(tab.label) + 2;
        const showClose = !!tab.onClose && (closeMode === "always" || active);
        const attributes = (active ? TextAttributes.BOLD : 0)
          | (
            (variant === "underline" && !compact && (active || hovered))
              || (variant === "bare" && focusedActive)
              ? TextAttributes.UNDERLINE
              : 0
          );
        const startHover = tab.disabled
          ? undefined
          : () => {
              setHoveredValue((current) => (current === tab.value ? current : tab.value));
            };
        const endHover = tab.disabled
          ? undefined
          : () => {
              setHoveredValue((current) => (current === tab.value ? null : current));
            };
        const selectTab = tab.disabled
          ? undefined
          : (event: TabPointerEvent) => {
              if (event.button === 2 && tab.onContextMenu) {
                event.preventDefault?.();
                event.stopPropagation?.();
                tab.onContextMenu(tab.value, event);
                return;
              }
              event.preventDefault();
              event.stopPropagation?.();
              if (onReorder && tab.reorderable !== false) {
                dragSourceValueRef.current = tab.value;
                capturePointerDrag(nativeRenderer, tabRowRef.current);
              }
              onSelect(tab.value);
            };

        return (
          <Box
            key={tab.value}
            ref={(renderable: BoxRenderable | null) => {
              if (renderable) tabRefs.current.set(tab.value, renderable);
              else tabRefs.current.delete(tab.value);
            }}
            width={tabWidth}
            height={1}
            flexDirection="row"
            backgroundColor={active && variant === "pill" ? palette.activeBg : hovered ? palette.hoverBg : undefined}
            onMouseOver={startHover}
            onMouseOut={endHover}
            onMouseDown={selectTab}
            onDoubleClick={tab.disabled || !tab.onDoubleClick ? undefined : () => tab.onDoubleClick?.(tab.value)}
          >
            <Text
              fg={tab.disabled ? palette.disabledFg : active && variant === "pill" ? palette.activePillFg : active ? palette.activeFg : hovered ? palette.hoverFg : tab.fg ?? palette.inactiveFg}
              attributes={attributes}
              onMouseDown={selectTab}
              selectable={onReorder ? false : undefined}
            >
              {dense ? `${tab.label} ` : ` ${tab.label} `}
            </Text>
            {showClose && (
              <Text
                fg={active && variant === "pill" ? palette.activePillFg : palette.closeFg}
                onMouseDown={(event: any) => {
                  event.preventDefault?.();
                  event.stopPropagation?.();
                  tab.onClose?.(tab.value);
                }}
              >
                {"x "}
              </Text>
            )}
          </Box>
        );
      })}
      {onAdd && (
        <Box
          width={addWidth}
          height={1}
          backgroundColor={hoveredValue === "__add__" ? palette.hoverBg : undefined}
          onMouseOver={() => setHoveredValue((current) => (current === "__add__" ? current : "__add__"))}
          onMouseOut={() => setHoveredValue((current) => (current === "__add__" ? null : current))}
          onMouseDown={(event: TabPointerEvent) => {
            event.preventDefault();
            onAdd();
          }}
        >
          <Text fg={hoveredValue === "__add__" ? palette.hoverFg : palette.addFg}>
            {dense ? `${addLabel} ` : ` ${addLabel} `}
          </Text>
        </Box>
      )}
    </Box>
  );

  if (!scrollable) return tabRow;

  // Drawn over the strip's end cells, so showing one never narrows the strip and moves what it reveals,
  // on the surface the strip sits on (`background`), so it reads as the strip's edge and not a tab's cell.
  const edgeMarker = (direction: -1 | 1) => (
    <Box
      position="absolute"
      top={0}
      {...direction < 0 ? { left: 0 } : { right: 0 }}
      width={1}
      height={1}
      zIndex={1}
      backgroundColor={palette.bg}
      onMouseDown={(event: TabPointerEvent) => {
        event.preventDefault();
        event.stopPropagation?.();
        scrollToward(direction);
      }}
    >
      <Text fg={palette.addFg}>{direction < 0 ? "‹" : "›"}</Text>
    </Box>
  );

  return (
    <Box width="100%" height={1}>
      <ScrollBox
        id={scrollId}
        ref={scrollRef}
        width="100%"
        height={1}
        scrollX
        focusable={false}
        horizontalScrollbarOptions={{ visible: false }}
        onMouseScroll={handleMouseScroll}
      >
        {tabRow}
      </ScrollBox>
      {edges.left ? edgeMarker(-1) : null}
      {edges.right ? edgeMarker(1) : null}
    </Box>
  );
}
