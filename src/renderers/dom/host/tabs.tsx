/** @jsxImportSource react */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { HostTabsProps } from "../../../ui/host";
import { WEB_CELL_HEIGHT } from "../../../theme/font-scale";
import { WebIcon, WebIconButton } from "../desktop/icons";
import { WebMenu } from "../desktop/menu";
import { WebPopover } from "../desktop/popover";
import { useHorizontalOverflow } from "./overflow-fade";
import { hideDragShield, showDragShield } from "./drag-shield";

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
  onDrag,
  focused = false,
  palette,
}: HostTabsProps) {
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragOffsetXRef = useRef(0);
  const dragSourceWidthRef = useRef(0);
  const suppressClickRef = useRef(false);
  const [dragSourceValue, setDragSourceValue] = useState<string | null>(null);
  const [dragTargetValue, setDragTargetValue] = useState<string | null>(null);
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const header = variant === "header";
  // A tab bar occupies exactly the one row every caller reserves for it. Any
  // extra pixels here are pixels the pane's children are told they own and the
  // pane then clips, which is how a chart's time axis ends up behind a footer.
  // Title-bar tabs fill the header to its bottom edge, so the active tab's
  // underline lies on the header's bottom rule. Every variant draws the one tab
  // look in styles.css: text, and the active tab on an accent underline.
  const listHeight = header ? "100%" : variant === "underline" || compact ? WEB_CELL_HEIGHT : "100%";

  useEffect(() => () => dragCleanupRef.current?.(), []);

  // A strip wider than its pane scrolls sideways; fade the edge hiding tabs.
  const overflow = useHorizontalOverflow(tabListRef, [tabs]);
  // The fade is set exactly while some tab is out of view.
  const overflowing = overflow.maskStyle.maskImage !== undefined;

  // Again once the overflow chevron appears: it narrows the strip, which would
  // otherwise push the last tab's label past the edge.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeValue, tabs, overflowing]);
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
      hideDragShield();
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
      showDragShield();
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

  // A click selects the tab. A drag moves the window, and the listeners come off
  // before that starts so a native move that swallows mouseup cannot leave them on.
  const startPressDrag = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !onDrag) return;
    dragCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const cleanup = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      window.removeEventListener("blur", handleUp);
      dragCleanupRef.current = null;
    };
    const handleMove = (moveEvent: MouseEvent) => {
      if (moveEvent.buttons === 0) {
        cleanup();
        return;
      }
      if (moved) return;
      if (Math.abs(moveEvent.clientX - startX) < 4 && Math.abs(moveEvent.clientY - startY) < 4) return;
      moved = true;
      suppressClickRef.current = true;
      cleanup();
      onDrag();
    };
    const handleUp = () => {
      cleanup();
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    window.addEventListener("blur", handleUp);
    dragCleanupRef.current = cleanup;
  };

  const dragSourceIndex = tabs.findIndex((tab) => tab.value === dragSourceValue);
  const dragTargetIndex = tabs.findIndex((tab) => tab.value === dragTargetValue);
  const dragSlotWidth = dragSourceWidthRef.current;

  const tabList = (
    <div
      ref={tabListRef}
      data-gloom-role="tab-list"
      role="tablist"
      onWheel={overflow.onWheel}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        gap: 0,
        width: "100%",
        height: listHeight,
        minInlineSize: 0,
        flexShrink: header ? 1 : 0,
        overflowX: "auto",
        overflowY: "hidden",
        boxSizing: "border-box",
        ...overflow.maskStyle,
      }}
    >
      {tabs.map((tab, index) => {
        const active = tab.value === activeValue;
        const disabled = tab.disabled === true;
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
          // The look is the tab rule in styles.css; only the active colour
          // (bright while the pane is focused) and the drag geometry are set here.
          "--tab-active-fg": header ? "var(--pane-tab-active-fg)" : palette.activeFg,
          flex: "0 0 auto",
          minWidth: 0,
          margin: 0,
          transform: `translateX(${dragTranslateX}px)${sourceDragging ? " scale(1.03)" : ""}`,
          zIndex: dragSourceValue === tab.value ? 2 : undefined,
          willChange: dragSourceValue ? "transform" : undefined,
          transition: `color 110ms ease, transform ${dragSourceValue && dragSourceValue !== tab.value ? "var(--tab-reorder-duration, 160ms)" : "0ms"} cubic-bezier(0.77, 0, 0.175, 1)`,
          cursor: disabled ? "default" : dragSourceValue ? "grabbing" : reorderable ? "grab" : "pointer",
          ...(dragTarget ? { color: "var(--gloom-text)" } : {}),
        } satisfies CssVars;

        return (
          <button
            key={tab.value}
            ref={active ? activeTabRef : undefined}
            data-gloom-role="tab-button"
            data-active={active ? "true" : undefined}
            data-dense={dense || compact ? "true" : undefined}
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
            onMouseDown={reorderable ? (event) => startReorder(tab.value, event) : onDrag ? startPressDrag : undefined}
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
                  marginRight: "calc(-1 * var(--gloom-space-xs))",
                  color: "var(--gloom-text-muted)",
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
          </button>
        );
      })}
      {onAdd && (
        <button
          data-gloom-role="tab-button"
          data-dense={dense || compact ? "true" : undefined}
          type="button"
          style={{ flex: "0 0 auto", margin: 0, cursor: "pointer" }}
          aria-label={addLabel === "+" ? "Add tab" : undefined}
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
