/** @jsxImportSource react */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { HostTabsProps } from "../../../../ui/host";
import { WEB_CELL_HEIGHT } from "../input-host";

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
  const showUnderline = variant === "underline" && !compact;
  // A tab bar occupies exactly the one row every caller reserves for it. Any
  // extra pixels here are pixels the pane's children are told they own and the
  // pane then clips, which is how a chart's time axis ends up behind a footer.
  const listHeight = showUnderline || compact ? WEB_CELL_HEIGHT : "100%";
  const tabFontSize = compact || showUnderline ? 12 : 13;
  const tabPaddingInline = dense ? 5 : showUnderline ? 10 : 8;
  const tabPaddingBlock = variant === "bare" || variant === "pill" ? 2 : 0;

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeValue, tabs]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

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

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollWidth <= element.clientWidth) return;
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;

    element.scrollLeft += event.deltaY;
    event.preventDefault();
  };

  const resolveTabBackground = (active: boolean, hovered: boolean) => {
    if (active && variant === "pill") {
      return hovered
        ? `color-mix(in srgb, ${palette.activeBg} 76%, ${palette.hoverBg})`
        : palette.activeBg;
    }
    return hovered ? palette.hoverBg : "transparent";
  };

  const resolveTabColor = (disabled: boolean, active: boolean, hovered: boolean) => {
    if (disabled) return palette.disabledFg;
    if (active && variant === "pill") return palette.activePillFg;
    if (active) return palette.activeFg;
    if (hovered) return palette.hoverFg;
    return palette.inactiveFg;
  };

  const dragSourceIndex = tabs.findIndex((tab) => tab.value === dragSourceValue);
  const dragTargetIndex = tabs.findIndex((tab) => tab.value === dragTargetValue);
  const dragSlotWidth = dragSourceWidthRef.current + (dense ? 2 : 4);

  return (
    <div
      ref={tabListRef}
      data-gloom-role="tab-list"
      role="tablist"
      onWheel={handleWheel}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        gap: dense ? 2 : 4,
        width: "100%",
        height: listHeight,
        minInlineSize: 0,
        flexShrink: 0,
        overflowX: "auto",
        overflowY: "hidden",
        paddingInline: variant === "underline" || dense ? 0 : 4,
        paddingBlock: tabPaddingBlock,
        boxSizing: "border-box",
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
          height: "100%",
          paddingInline: tabPaddingInline,
          paddingBlock: 0,
          paddingBottom: showUnderline ? 2 : 0,
          margin: 0,
          border: "1px solid transparent",
          borderRadius: variant === "underline" ? 5 : 6,
          background: resolveTabBackground(active, hovered || dragTarget),
          boxSizing: "border-box",
          font: "inherit",
          fontSize: tabFontSize,
          fontWeight: active ? 700 : 500,
          lineHeight: 1,
          textAlign: "center",
          whiteSpace: "nowrap",
          borderColor: active && focused && variant !== "pill"
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
                {"x"}
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
          onMouseEnter={() => setHoveredValue("__add__")}
          onMouseLeave={() => setHoveredValue((current) => (current === "__add__" ? null : current))}
          onClick={onAdd}
        >
          <span
            data-gloom-role="tab-label"
            style={{
              display: "block",
            }}
          >
            {addLabel}
          </span>
        </button>
      )}
    </div>
  );
}
