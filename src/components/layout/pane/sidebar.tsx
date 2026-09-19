import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Box, Text, useNativeRenderer, useUiCapabilities, type BoxRenderable } from "../../../ui";
import { capturePointerDrag } from "../../../ui/pointer-drag";
import { blendHex, colors, hoverBg } from "../../../theme/colors";

const PANE_SIDEBAR_MIN_WIDTH = 18;
const PANE_SIDEBAR_MAX_WIDTH = 24;
const DESKTOP_PANE_SIDEBAR_MIN_WIDTH = 14;
const DESKTOP_PANE_SIDEBAR_MAX_WIDTH = 19;
const DESKTOP_PANE_SIDEBAR_WIDTH_RATIO = 0.192;
const PANE_SIDEBAR_BREAKPOINT = 72;
const PANE_SIDEBAR_MOUSE_HANDLED = "__gloomberbPaneSidebarHandled";
// Dragging leaves the automatic width behind, so it may go narrower than the
// responsive floor and as wide as half the pane before the list starves it.
const PANE_SIDEBAR_DRAG_MIN_WIDTH = 10;
const PANE_SIDEBAR_DRAG_MAX_RATIO = 0.5;
/** Pixels of grab area around the divider; the divider itself stays 1px. */
const DESKTOP_RESIZE_HANDLE_PADDING_PX = 3;

export function shouldShowPaneSidebar(
  itemCount: number,
  width: number,
  height: number,
  minimumItemCount = 2,
): boolean {
  return itemCount >= minimumItemCount && width >= PANE_SIDEBAR_BREAKPOINT && height >= 8;
}

/** The width range a dragged sidebar may take inside a pane of `width` cells. */
export function getPaneSidebarWidthRange(width: number): { min: number; max: number } {
  return {
    min: PANE_SIDEBAR_DRAG_MIN_WIDTH,
    max: Math.max(PANE_SIDEBAR_DRAG_MIN_WIDTH, Math.floor(width * PANE_SIDEBAR_DRAG_MAX_RATIO)),
  };
}

export function getPaneSidebarWidth(width: number, nativePaneChrome: boolean, preferredWidth?: number | null): number {
  if (preferredWidth != null && Number.isFinite(preferredWidth)) {
    const range = getPaneSidebarWidthRange(width);
    return Math.min(range.max, Math.max(range.min, Math.round(preferredWidth)));
  }
  const minimumWidth = nativePaneChrome ? DESKTOP_PANE_SIDEBAR_MIN_WIDTH : PANE_SIDEBAR_MIN_WIDTH;
  const maximumWidth = nativePaneChrome ? DESKTOP_PANE_SIDEBAR_MAX_WIDTH : PANE_SIDEBAR_MAX_WIDTH;
  const widthRatio = nativePaneChrome ? DESKTOP_PANE_SIDEBAR_WIDTH_RATIO : 0.24;
  return Math.min(maximumWidth, Math.max(minimumWidth, Math.floor(width * widthRatio)));
}

export interface PaneSidebarRenderState {
  backgroundColor: string;
  listWidth: number;
}

interface PaneSidebarContextValue extends PaneSidebarRenderState {
  activeBackgroundColor: string;
  keyboardFocused: boolean;
}

const PaneSidebarContext = createContext<PaneSidebarContextValue | null>(null);

function usePaneSidebarContext(): PaneSidebarContextValue {
  const context = useContext(PaneSidebarContext);
  if (!context) throw new Error("PaneSidebarRow and PaneSidebarAction must be rendered inside PaneSidebar.");
  return context;
}

export interface PaneSidebarResize {
  /** Narrowest and widest the divider may be dragged to, in cells. */
  min: number;
  max: number;
  /** Fires on every frame of the drag with the clamped width. */
  onResize: (width: number) => void;
  /** Fires once the pointer is released, for callers that persist the width. */
  onResizeEnd?: (width: number) => void;
}

interface PaneSidebarPointerEvent {
  x?: number;
  preciseX?: number;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export function PaneSidebar({
  width,
  height,
  focused,
  keyboardFocused = false,
  resize,
  children,
}: {
  width: number;
  height: number;
  focused: boolean;
  keyboardFocused?: boolean;
  /** Makes the divider a drag handle; omit to keep the sidebar a fixed width. */
  resize?: PaneSidebarResize;
  children: ReactNode | ((state: PaneSidebarRenderState) => ReactNode);
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const nativeRenderer = useNativeRenderer();
  const dividerRef = useRef<BoxRenderable>(null);
  const dragOriginRef = useRef<{ pointerX: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [dividerHovered, setDividerHovered] = useState(false);

  const resolveDragWidth = useCallback((event?: PaneSidebarPointerEvent) => {
    const origin = dragOriginRef.current;
    if (!origin || !resize) return null;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const pointerX = event?.preciseX ?? event?.x ?? origin.pointerX;
    const next = Math.round(origin.width + (pointerX - origin.pointerX));
    return Math.min(resize.max, Math.max(resize.min, next));
  }, [resize]);

  const beginResize = useCallback((event?: PaneSidebarPointerEvent) => {
    if (!resize) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    dragOriginRef.current = { pointerX: event?.preciseX ?? event?.x ?? 0, width };
    setResizing(true);
    capturePointerDrag(nativeRenderer, dividerRef.current);
  }, [nativeRenderer, resize, width]);

  const continueResize = useCallback((event?: PaneSidebarPointerEvent) => {
    const next = resolveDragWidth(event);
    if (next !== null) resize?.onResize(next);
  }, [resize, resolveDragWidth]);

  const endResize = useCallback((event?: PaneSidebarPointerEvent) => {
    const next = resolveDragWidth(event);
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    setResizing(false);
    // A click that never moved is not a resize: leave the width as it was,
    // so tapping the divider does not pin a sidebar that still follows the pane.
    if (next === null || next === origin?.width) return;
    (resize?.onResizeEnd ?? resize?.onResize)?.(next);
  }, [resize, resolveDragWidth]);

  const borderWidth = nativePaneChrome ? 0 : width > 1 ? 1 : 0;
  const listWidth = Math.max(width - borderWidth, 1);
  const dividerColor = focused ? colors.borderFocused : colors.border;
  const backgroundColor = keyboardFocused
    ? blendHex(colors.panel, colors.borderFocused, 0.18)
    : colors.panel;
  const activeBackgroundColor = keyboardFocused
    ? blendHex(colors.selected, colors.borderFocused, 0.32)
    : blendHex(colors.panel, colors.selected, 0.35);
  const sidebarLayoutHeight = nativePaneChrome ? "100%" : height;
  const nativeFillStyle = nativePaneChrome ? { minHeight: 0 } : undefined;
  const renderState = { backgroundColor, listWidth };
  const dividerActive = resizing || dividerHovered;
  const resizeHandlers = resize && {
    onMouseDown: beginResize,
    onMouseDrag: continueResize,
    onMouseDragEnd: endResize,
    onMouseOver: () => setDividerHovered(true),
    onMouseOut: () => setDividerHovered(false),
  };

  return (
    <PaneSidebarContext.Provider value={{ ...renderState, activeBackgroundColor, keyboardFocused }}>
      <Box
        width={width}
        height={sidebarLayoutHeight}
        flexDirection="row"
        position="relative"
        style={nativeFillStyle}
        data-gloom-role="pane-sidebar"
      >
        <Box
          width={listWidth}
          height={sidebarLayoutHeight}
          flexDirection="column"
          backgroundColor={backgroundColor}
          style={nativeFillStyle}
        >
          {typeof children === "function" ? children(renderState) : children}
        </Box>
        {borderWidth > 0 && (
          <Box
            ref={dividerRef}
            width={1}
            height={height}
            flexDirection="column"
            {...resizeHandlers}
          >
            {Array.from({ length: height }, (_, index) => (
              <Text key={index} fg={dividerActive ? colors.borderFocused : dividerColor} selectable={false}>│</Text>
            ))}
          </Box>
        )}
        {nativePaneChrome && (
          <Box
            position="absolute"
            top={0}
            right={0}
            width={1}
            height={sidebarLayoutHeight}
            style={{
              width: 1,
              height: "100%",
              backgroundColor: dividerActive ? colors.borderFocused : dividerColor,
              pointerEvents: "none",
            }}
          />
        )}
        {nativePaneChrome && resize && (
          // A 1px line is too thin to grab, so the handle straddles it.
          <Box
            ref={dividerRef}
            position="absolute"
            top={0}
            right={0}
            width={1}
            height={sidebarLayoutHeight}
            {...resizeHandlers}
            style={{
              width: 1 + DESKTOP_RESIZE_HANDLE_PADDING_PX * 2,
              right: -DESKTOP_RESIZE_HANDLE_PADDING_PX,
              height: "100%",
              cursor: "col-resize",
            }}
          />
        )}
      </Box>
    </PaneSidebarContext.Provider>
  );
}

export interface PaneSidebarRowRenderState {
  foregroundColor: string;
  listWidth: number;
  onMouseDown: (event?: any) => void;
}

export function PaneSidebarRow({
  active,
  disabled = false,
  height = 1,
  ariaLabel,
  onSelect,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  height?: number;
  ariaLabel: string;
  onSelect?: (event?: any) => void;
  children: ReactNode | ((state: PaneSidebarRowRenderState) => ReactNode);
}) {
  const { activeBackgroundColor, backgroundColor, keyboardFocused, listWidth } = usePaneSidebarContext();
  const [hovered, setHovered] = useState(false);
  const foregroundColor = active
    ? colors.selectedText
    : keyboardFocused
      ? colors.text
      : colors.textDim;
  const rowBackgroundColor = active ? activeBackgroundColor : hovered ? hoverBg() : backgroundColor;
  const handleMouseDown = (event?: any) => {
    if (disabled) return;
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (event[PANE_SIDEBAR_MOUSE_HANDLED]) return;
      event[PANE_SIDEBAR_MOUSE_HANDLED] = true;
    }
    onSelect?.(event);
  };
  const renderState = { foregroundColor, listWidth, onMouseDown: handleMouseDown };

  return (
    <Box
      height={height}
      width={listWidth}
      flexDirection="row"
      backgroundColor={rowBackgroundColor}
      aria-label={ariaLabel}
      data-gloom-role="pane-sidebar-item"
      onMouseDown={handleMouseDown}
      onMouseOver={() => {
        if (!disabled) setHovered((current) => current ? current : true);
      }}
      onMouseOut={() => setHovered((current) => current ? false : current)}
      style={{ cursor: disabled ? "default" : "pointer" }}
    >
      {typeof children === "function" ? children(renderState) : children}
    </Box>
  );
}

export interface PaneSidebarActionRenderState {
  foregroundColor: string;
  hovered: boolean;
  onMouseDown: (event?: any) => void;
}

export function PaneSidebarAction({
  width,
  ariaLabel,
  disabled = false,
  highlightOnHover = true,
  onPress,
  children,
}: {
  width: number;
  ariaLabel: string;
  disabled?: boolean;
  highlightOnHover?: boolean;
  onPress?: (event?: any) => void;
  children: ReactNode | ((state: PaneSidebarActionRenderState) => ReactNode);
}) {
  usePaneSidebarContext();
  const [hovered, setHovered] = useState(false);
  const handleMouseDown = (event?: any) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (event) {
      if (event[PANE_SIDEBAR_MOUSE_HANDLED]) return;
      event[PANE_SIDEBAR_MOUSE_HANDLED] = true;
    }
    if (disabled) return;
    onPress?.(event);
  };
  const renderState = {
    foregroundColor: hovered ? colors.textMuted : colors.textDim,
    hovered,
    onMouseDown: handleMouseDown,
  };

  return (
    <Box
      width={width}
      height={1}
      alignItems="center"
      justifyContent="center"
      backgroundColor={hovered && highlightOnHover ? hoverBg() : undefined}
      aria-label={ariaLabel}
      data-gloom-role="pane-sidebar-action"
      onMouseOver={() => {
        if (!disabled) setHovered((current) => current ? current : true);
      }}
      onMouseOut={() => setHovered((current) => current ? false : current)}
      onMouseDown={handleMouseDown}
      style={{ cursor: disabled ? "default" : "pointer" }}
    >
      {typeof children === "function" ? children(renderState) : children}
    </Box>
  );
}
