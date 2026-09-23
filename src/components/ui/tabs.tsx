import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  focused?: boolean;
  keyboardNavigation?: boolean;
  scrollable?: boolean;
  scrollId?: string;
}

const WHEEL_DELTA_PER_CELL = 8;

export function Tabs({
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
  focused = false,
  keyboardNavigation = true,
  scrollable = true,
  scrollId,
}: TabsProps) {
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
    if (event.ctrl || event.meta || event.alt || event.targetEditable) return;

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
  }, { enabled: focused && keyboardNavigation });

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
  const revealRef = useRef({ tabWidths, totalWidth, activeIndex: -1 });
  revealRef.current = {
    tabWidths,
    totalWidth,
    activeIndex: tabs.findIndex((tab) => tab.value === activeValue),
  };
  const revealActiveTab = useCallback(() => {
    const scrollBox = scrollRef.current;
    const { tabWidths: widths, totalWidth: stripWidth, activeIndex } = revealRef.current;
    const viewportWidth = scrollBox?.viewport?.width || scrollBox?.width || 0;
    if (!scrollBox || activeIndex < 0 || viewportWidth <= 0) return;

    const activeLeft = widths.slice(0, activeIndex).reduce((sum, width) => sum + width, 0);
    const activeRight = activeLeft + widths[activeIndex]!;
    const currentLeft = scrollBox.scrollLeft ?? 0;
    const currentRight = currentLeft + viewportWidth;
    const maxScrollLeft = Math.max(0, stripWidth - viewportWidth);
    const scrollToLeft = (left: number) => {
      scrollBox.scrollLeft = left;
      scrollBox.scrollTo({ x: left, y: scrollBox.scrollTop });
    };

    if (activeLeft < currentLeft) {
      scrollToLeft(activeLeft);
    } else if (activeRight > currentRight) {
      scrollToLeft(Math.min(activeRight - viewportWidth, maxScrollLeft));
    }
  }, []);
  useEffect(revealActiveTab, [revealActiveTab, revealKey]);
  // React effects can run before a floating pane's native viewport has its
  // new width. Retry after computed layout, preserving ScrollBox's range update.
  useEffect(() => observeScrollBoxViewportSize(scrollRef.current, revealActiveTab), [revealActiveTab, scrollable]);
  useEffect(() => observeScrollBoxContentSize(scrollRef.current, revealActiveTab), [revealActiveTab, scrollable]);

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
    const maxScrollLeft = Math.max(0, totalWidth - viewportWidth);
    const nextLeft = Math.max(
      0,
      Math.min(maxScrollLeft, (scrollBox.scrollLeft ?? 0) + directionSign * deltaCells),
    );
    scrollBox.scrollLeft = nextLeft;
    scrollBox.scrollTo({ x: nextLeft, y: scrollBox.scrollTop });
  };

  const tabRow = (
    <Box
      ref={tabRowRef}
      flexDirection="row"
      width={totalWidth}
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

  return (
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
  );
}
