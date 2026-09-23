/** @jsxImportSource react */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { HostTabsProps } from "../../../../ui/host";
import { WEB_CELL_HEIGHT } from "../input-host";
import { WebIcon, WebIconButton } from "../desktop/icons";
import { WebMenu } from "../desktop/menu";
import { WebPopover } from "../desktop/popover";
import { useHorizontalOverflow } from "./overflow-fade";
import { useTopSurfaceColor } from "./top-surface";

type CssVars = CSSProperties & Record<`--${string}`, string>;

export function WebTabs({
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
  palette,
}: HostTabsProps) {
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragOffsetXRef = useRef(0);
  const dragSourceWidthRef = useRef(0);
  const suppressClickRef = useRef(false);
  const [hoveredValue, setHoveredValue] = useState<string | null>(null);
  const [dragSourceValue, setDragSourceValue] = useState<string | null>(null);
  const [dragTargetValue, setDragTargetValue] = useState<string | null>(null);
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const header = variant === "header";
  const showUnderline = variant === "underline" && !compact;
  // A tab bar occupies exactly the one row every caller reserves for it. Any
  // extra pixels here are pixels the pane's children are told they own and the
  // pane then clips, which is how a chart's time axis ends up behind a footer.
  // Title-bar tabs fill the header to its bottom edge. The header draws its
  // bottom rule inside its own box, so the active tab covers it exactly at any
  // zoom and opens into the pane body; inactive tabs sit on the rule.
  const listHeight = header ? "100%" : showUnderline || compact ? WEB_CELL_HEIGHT : "100%";
  const tabFontSize = compact || showUnderline ? 12 : 13;
  const tabPaddingInline = header ? 10 : dense ? 5 : showUnderline ? 10 : 8;
  const tabPaddingBlock = variant === "bare" || variant === "pill" ? 2 : 0;

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeValue, tabs]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  // A strip wider than its pane scrolls sideways; fade the edge hiding tabs.
  const overflow = useHorizontalOverflow(tabListRef, [tabs]);
  // The fade is set exactly while some tab is out of view.
  const overflowing = overflow.maskStyle.maskImage !== undefined;
  useEffect(() => {
    if (!overflowing) setOverflowMenuOpen(false);
  }, [overflowing]);

  const selectFromOverflowMenu = (value: string) => {
    setOverflowMenuOpen(false);
    onSelect(value);
    // Also when the chosen tab was already active, so the effect above does not run.
    requestAnimationFrame(() => {
      tabListRef.current
        ?.querySelector<HTMLElement>(`[data-tab-value="${CSS.escape(value)}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  };
  // The active title-bar tab opens into the pane, so it takes the colour of
  // whatever is directly under it.
  useTopSurfaceColor(tabListRef, header, [activeValue, tabs, focused]);

  const startReorder = (sourceValue: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragCleanupRef.current?.();
    const sourceElement = event.currentTarget;
    const sourceBounds = sourceElement.getBoundingClientRect();
    const startX = event.clientX;
    const targets = [...tabListRef.current?.querySelectorAll<HTMLButtonElement>("[data-reorderable='true']") ?? []]
      .map((button) => ({ value: button.dataset.tabValue ?? "", bounds: button.getBoundingClientRect() }));
    const resolveTarget = (clientX: number) => targets.reduce((closest, target) => {
      const distance = clientX < target.bounds.left
        ? target.bounds.left - clientX
        : clientX > target.bounds.right ? clientX - target.bounds.right : 0;
      return distance < closest.distance ? { value: target.value, distance } : closest;
    }, { value: "", distance: Number.POSITIVE_INFINITY }).value || null;
    let dragged = false;

    const cleanup = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      document.body.classList.remove("gloom-dragging");
      dragCleanupRef.current = null;
      dragOffsetXRef.current = 0;
      dragSourceWidthRef.current = 0;
      setDragSourceValue(null);
      setDragTargetValue(null);
    };
    const handleMove = (moveEvent: MouseEvent) => {
      const offsetX = moveEvent.clientX - startX;
      if (!dragged && Math.abs(offsetX) < 4) return;
      dragged = true;
      moveEvent.preventDefault();
      dragOffsetXRef.current = offsetX;
      sourceElement.style.transform = `translateX(${offsetX}px) scale(1.03)`;
      document.body.classList.add("gloom-dragging");
      setDragTargetValue(resolveTarget(sourceBounds.left + offsetX + sourceBounds.width / 2));
    };
    const handleUp = (upEvent: MouseEvent) => {
      const targetValue = resolveTarget(sourceBounds.left + upEvent.clientX - startX + sourceBounds.width / 2);
      suppressClickRef.current = dragged;
      cleanup();
      if (dragged && targetValue && targetValue !== sourceValue) {
        onReorder?.(sourceValue, targetValue);
      }
    };

    dragSourceWidthRef.current = sourceBounds.width;
    setDragSourceValue(sourceValue);
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    dragCleanupRef.current = cleanup;
  };

  const resolveTabBackground = (active: boolean, hovered: boolean) => {
    if (header) return active ? "var(--pane-tab-active-bg)" : hovered ? "var(--pane-tab-hover-bg)" : "transparent";
    if (active && variant === "pill") {
      return hovered
        ? `color-mix(in srgb, ${palette.activeBg} 76%, ${palette.hoverBg})`
        : palette.activeBg;
    }
    return hovered ? palette.hoverBg : "transparent";
  };

  const resolveTabColor = (disabled: boolean, active: boolean, hovered: boolean) => {
    if (disabled) return palette.disabledFg;
    if (header && active) return "var(--pane-tab-active-fg)";
    if (active && variant === "pill") return palette.activePillFg;
    if (active) return palette.activeFg;
    if (hovered) return palette.hoverFg;
    return palette.inactiveFg;
  };

  const dragSourceIndex = tabs.findIndex((tab) => tab.value === dragSourceValue);
  const dragTargetIndex = tabs.findIndex((tab) => tab.value === dragTargetValue);
  const dragSlotWidth = dragSourceWidthRef.current + (dense ? 2 : 4);

  const tabList = (
    <div
      ref={tabListRef}
      data-gloom-role="tab-list"
      role="tablist"
      onWheel={overflow.onWheel}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: header ? "flex-end" : "stretch",
        gap: header ? 2 : dense ? 2 : 4,
        width: "100%",
        height: listHeight,
        minInlineSize: 0,
        flexShrink: header ? 1 : 0,
        overflowX: "auto",
        overflowY: "hidden",
        paddingInline: header || variant === "underline" || dense ? 0 : 4,
        paddingBlock: tabPaddingBlock,
        boxSizing: "border-box",
        ...overflow.maskStyle,
      }}
    >
      {tabs.map((tab, index) => {
        const active = tab.value === activeValue;
        const disabled = tab.disabled === true;
        const hovered = hoveredValue === tab.value && !disabled;
        const closeVisible = !!tab.onClose && (closeMode === "always" || active);
        const reorderable = !!onReorder && !disabled && tab.reorderable !== false;
        const dragTarget = dragTargetValue === tab.value && dragSourceValue !== tab.value;
        const sourceDragging = dragSourceValue === tab.value && dragTargetValue !== null;
        const dragTranslateX = dragSourceValue === tab.value
          ? dragOffsetXRef.current
          : dragTargetIndex >= 0 && dragSourceIndex < dragTargetIndex && index > dragSourceIndex && index <= dragTargetIndex
            ? -dragSlotWidth
            : dragTargetIndex >= 0 && dragSourceIndex > dragTargetIndex && index >= dragTargetIndex && index < dragSourceIndex
              ? dragSlotWidth
              : 0;
        const tabStyle = {
          "--tab-fg": resolveTabColor(disabled, active, hovered),
          "--tab-hover-fg": palette.hoverFg,
          "--tab-underline": active ? palette.activeUnderline : palette.inactiveUnderline,
          "--tab-hover-underline": palette.hoverUnderline,
          "--tab-hover-bg": palette.hoverBg,
          "--tab-close-fg": active && variant === "pill" ? palette.activePillFg : palette.closeFg,
          color: "var(--tab-fg)",
          flex: "0 0 auto",
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          position: "relative",
          minWidth: 0,
          height: header ? "calc(100% - var(--pane-tab-top-gap, 2px))" : "100%",
          paddingInline: tabPaddingInline,
          paddingBlock: 0,
          // Header tabs reach the header's bottom edge; lifting the label by the
          // top gap keeps it on the centre line the title and buttons use.
          paddingBottom: header ? "var(--pane-tab-label-lift, 3px)" : showUnderline ? 2 : 0,
          margin: 0,
          border: "1px solid transparent",
          borderBottomWidth: header ? 0 : 1,
          borderRadius: header ? "6px 6px 0 0" : variant === "underline" ? 5 : 6,
          background: resolveTabBackground(active, hovered || dragTarget),
          boxSizing: "border-box",
          font: "inherit",
          fontSize: tabFontSize,
          fontWeight: active ? 700 : 500,
          // A unitless 1 clips descenders under the label's overflow guard.
          lineHeight: header ? "16px" : 1,
          textAlign: "center",
          whiteSpace: "nowrap",
          borderColor: header
            ? active ? "var(--pane-tab-border)" : "transparent"
            : active && focused && variant !== "pill"
            ? `color-mix(in srgb, ${palette.activeUnderline} 35%, transparent)`
            : "transparent",
          transform: `translateX(${dragTranslateX}px)${sourceDragging ? " scale(1.03)" : ""}`,
          zIndex: dragSourceValue === tab.value ? 2 : undefined,
          willChange: dragSourceValue ? "transform" : undefined,
          transition: `background-color 110ms ease, border-color 110ms ease, color 110ms ease, transform ${dragSourceValue && dragSourceValue !== tab.value ? "var(--tab-reorder-duration, 160ms)" : "0ms"} cubic-bezier(0.77, 0, 0.175, 1)`,
          cursor: disabled ? "default" : dragSourceValue ? "grabbing" : reorderable ? "grab" : "pointer",
        } satisfies CssVars;

        return (
          <button
            key={tab.value}
            ref={active ? activeTabRef : undefined}
            data-gloom-role="tab-button"
            data-active={active ? "true" : undefined}
            data-reorderable={reorderable ? "true" : undefined}
            data-tab-value={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            aria-disabled={disabled || undefined}
            disabled={disabled}
            draggable={false}
            aria-grabbed={reorderable && dragSourceValue === tab.value ? true : undefined}
            style={tabStyle}
            onMouseEnter={() => setHoveredValue(tab.value)}
            onMouseLeave={() => setHoveredValue((current) => (current === tab.value ? null : current))}
            onMouseDown={reorderable ? (event) => startReorder(tab.value, event) : undefined}
            onClick={(event) => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              if (!disabled) onSelect(tab.value);
            }}
            onDoubleClick={() => {
              if (!disabled) tab.onDoubleClick?.(tab.value);
            }}
            onContextMenu={tab.onContextMenu ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              tab.onContextMenu?.(tab.value, event);
            } : undefined}
          >
            <span
              data-gloom-role="tab-label"
              style={{
                display: "block",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {tab.label}
            </span>
            {closeVisible && (
              <span
                data-gloom-role="tab-close"
                aria-label={`Close ${tab.label}`}
                role="button"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 16,
                  height: 16,
                  marginRight: -4,
                  borderRadius: 4,
                  color: "var(--tab-close-fg)",
                  fontSize: 12,
                  lineHeight: 1,
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  tab.onClose?.(tab.value);
                }}
              >
                <WebIcon name="close" size={10} />
              </span>
            )}
            {showUnderline && (
              <span
                data-gloom-role="tab-underline"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 10,
                  right: 10,
                  bottom: 1,
                  height: 2,
                  borderRadius: 999,
                  background: "var(--tab-underline)",
                  opacity: active ? 1 : hovered ? 0.7 : 0,
                }}
              />
            )}
          </button>
        );
      })}
      {onAdd && (
        <button
          data-gloom-role="tab-button"
          type="button"
          style={{
            "--tab-fg": palette.addFg,
            "--tab-hover-fg": palette.hoverFg,
            "--tab-underline": palette.inactiveUnderline,
            "--tab-hover-underline": palette.hoverUnderline,
            "--tab-hover-bg": palette.hoverBg,
            color: hoveredValue === "__add__" ? palette.hoverFg : "var(--tab-fg)",
            flex: "0 0 auto",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            paddingInline: tabPaddingInline,
            paddingBlock: 0,
            margin: 0,
            border: 0,
            borderRadius: variant === "underline" ? 5 : 6,
            background: hoveredValue === "__add__" ? palette.hoverBg : "transparent",
            font: "inherit",
            fontSize: tabFontSize,
            fontWeight: 500,
            lineHeight: 1,
            whiteSpace: "nowrap",
            transition: "background-color 110ms ease, color 110ms ease",
            cursor: "pointer",
          } as CssVars}
          aria-label={addLabel === "+" ? "Add tab" : undefined}
          onMouseEnter={() => setHoveredValue("__add__")}
          onMouseLeave={() => setHoveredValue((current) => (current === "__add__" ? null : current))}
          onClick={onAdd}
        >
          {addLabel === "+" ? (
            <WebIcon name="plus" size={11} />
          ) : (
            <span
              data-gloom-role="tab-label"
              style={{
                display: "block",
              }}
            >
              {addLabel}
            </span>
          )}
        </button>
      )}
    </div>
  );

  if (!header) return tabList;

  // Title-bar strips can hold more tabs than the pane is wide (a research
  // pane has two dozen). A chevron after the strip lists every tab.
  return (
    <div data-gloom-role="tab-strip" style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", minWidth: 0 }}>
      {tabList}
      {overflowing && (
        <div data-gloom-role="tab-overflow" className="gloom-tab-overflow">
          <WebPopover
            open={overflowMenuOpen}
            onOpenChange={setOverflowMenuOpen}
            placement="bottom-end"
            minWidth={170}
            label="Tabs"
            density="menu"
            trigger={(
              <WebIconButton
                icon="chevron-down"
                label="All tabs"
                hasPopup="menu"
                size={10}
                onPress={() => setOverflowMenuOpen((open) => !open)}
              />
            )}
          >
            <WebMenu
              label="Tabs"
              selection="single"
              items={tabs.map((tab) => ({
                id: tab.value,
                label: tab.label,
                disabled: tab.disabled,
                selected: tab.value === activeValue,
              }))}
              onSelect={selectFromOverflowMenu}
              onClose={() => setOverflowMenuOpen(false)}
            />
          </WebPopover>
        </div>
      )}
    </div>
  );
}
