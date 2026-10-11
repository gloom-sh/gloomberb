import { createContext, startTransition, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, useNativeRenderer, useUiCapabilities, type BoxRenderable } from "../../../ui";
import { beginLiveResize, createCatchUp, type CatchUp } from "../../../ui/live-resize";
import { capturePointerDrag } from "../../../ui/pointer-drag";
import { blendHex, colors, hoverBg } from "../../../theme/colors";
import { t } from "../../../i18n";
import { usePaneFooter } from "./footer/registration";

// The width and visibility maths live in a module with no React in it, so a
// store can read them without importing a component tree.
export {
  getPaneSidebarWidth,
  getPaneSidebarWidthRange,
  readStoredPaneSidebarWidth,
  shouldShowPaneSidebar,
} from "./sidebar-metrics";

const PANE_SIDEBAR_MOUSE_HANDLED = "__gloomberbPaneSidebarHandled";
/** Pixels of grab area around the divider; the divider itself stays 1px. */
const DESKTOP_RESIZE_HANDLE_PADDING_PX = 3;
/** Cells one press of `<` or `>` moves the divider. */
const KEYBOARD_RESIZE_STEP = 2;
const NARROW_KEY = "<";
const WIDEN_KEY = ">";

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
  /**
   * Fires as the drag goes with the clamped width: on every frame in the
   * terminal, a few times a second on the desktop, where the divider and the
   * sidebar's box follow the pointer on their own in between.
   */
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
  const sidebarRef = useRef<BoxRenderable>(null);
  const dragOriginRef = useRef<{ pointerX: number; width: number } | null>(null);
  /**
   * Desktop drag: the sidebar's box follows the pointer by restyling itself
   * (`setLiveFrame`), and its content catches up through `onResize` a few
   * times a second, at the width last caught up to.
   */
  const liveDragRef = useRef<{ width: number; caughtUp: number; catchUp: CatchUp; end: () => void } | null>(null);
  const resizeRef = useRef(resize);
  resizeRef.current = resize;
  const [resizing, setResizing] = useState(false);
  const [dividerHovered, setDividerHovered] = useState(false);

  /** Where the pointer has the divider, in cells, clamped; whole cells unless `precise`. */
  const resolveDragWidth = useCallback((event?: PaneSidebarPointerEvent, precise = false) => {
    const origin = dragOriginRef.current;
    if (!origin || !resize) return null;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const pointerX = event?.preciseX ?? event?.x ?? origin.pointerX;
    const next = origin.width + (pointerX - origin.pointerX);
    return Math.min(resize.max, Math.max(resize.min, precise ? next : Math.round(next)));
  }, [resize]);

  const stopLiveDrag = useCallback(() => {
    const drag = liveDragRef.current;
    if (!drag) return null;
    liveDragRef.current = null;
    drag.catchUp.cancel();
    sidebarRef.current?.setLiveFrame?.(null);
    drag.end();
    return drag;
  }, []);
  useEffect(() => () => { stopLiveDrag(); }, [stopLiveDrag]);
  // A catch-up renders the sidebar at whole cells; its box stays where the pointer has it.
  useLayoutEffect(() => {
    const drag = liveDragRef.current;
    if (drag) sidebarRef.current?.setLiveFrame?.({ width: drag.width });
  });

  const beginResize = useCallback((event?: PaneSidebarPointerEvent) => {
    if (!resize) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    dragOriginRef.current = { pointerX: event?.preciseX ?? event?.x ?? 0, width };
    setResizing(true);
    capturePointerDrag(nativeRenderer, dividerRef.current);
    stopLiveDrag();
    if (nativePaneChrome && sidebarRef.current?.setLiveFrame) {
      const drag = {
        width,
        caughtUp: width,
        end: beginLiveResize(),
        catchUp: createCatchUp(() => {
          const next = Math.round(drag.width);
          if (liveDragRef.current !== drag || next === drag.caughtUp) return;
          drag.caughtUp = next;
          // In slices between the frames the drag draws; the release renders at once.
          startTransition(() => resizeRef.current?.onResize(next));
        }),
      };
      liveDragRef.current = drag;
    }
  }, [nativePaneChrome, nativeRenderer, resize, stopLiveDrag, width]);

  const continueResize = useCallback((event?: PaneSidebarPointerEvent) => {
    const drag = liveDragRef.current;
    if (drag) {
      const next = resolveDragWidth(event, true);
      if (next === null || next === drag.width) return;
      drag.width = next;
      sidebarRef.current?.setLiveFrame?.({ width: next });
      drag.catchUp.request();
      return;
    }
    const next = resolveDragWidth(event);
    if (next !== null) resize?.onResize(next);
  }, [resize, resolveDragWidth]);

  const endResize = useCallback((event?: PaneSidebarPointerEvent) => {
    const next = resolveDragWidth(event);
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    setResizing(false);
    // The box goes back to the width React last drew, and the release draws
    // the final one in the same commit.
    const drag = stopLiveDrag();
    // A click that never moved is not a resize: leave the width as it was,
    // so tapping the divider does not pin a sidebar that still follows the pane.
    if (next === null || next === origin?.width) {
      // Dragged out and back: undo what the content caught up to.
      if (next !== null && drag && drag.caughtUp !== next) resize?.onResize(next);
      return;
    }
    (resize?.onResizeEnd ?? resize?.onResize)?.(next);
  }, [resize, resolveDragWidth, stopLiveDrag]);

  // The keyboard moves the divider too: `<` and `>` while the pane is focused,
  // listed in the pane menu. Each press is a finished resize, so it persists.
  const resizeRegistrationId = `pane-sidebar-resize:${useId()}`;
  const canNarrow = !!resize && width > resize.min;
  const canWiden = !!resize && width < resize.max;
  const stepResize = (delta: number) => {
    if (!resize) return;
    const next = Math.min(resize.max, Math.max(resize.min, width + delta));
    if (next !== width) (resize.onResizeEnd ?? resize.onResize)(next);
  };
  usePaneFooter(resizeRegistrationId, () => (resize ? {
    keys: [
      { id: "sidebar-narrow", key: NARROW_KEY, label: "", onPress: () => stepResize(-KEYBOARD_RESIZE_STEP), disabled: !canNarrow },
      { id: "sidebar-widen", key: WIDEN_KEY, label: "", onPress: () => stepResize(KEYBOARD_RESIZE_STEP), disabled: !canWiden },
    ],
    menu: [
      ...(canNarrow ? [{ id: "sidebar-narrow", label: t("Narrow Sidebar"), accelerator: NARROW_KEY, onSelect: () => stepResize(-KEYBOARD_RESIZE_STEP) }] : []),
      ...(canWiden ? [{ id: "sidebar-widen", label: t("Widen Sidebar"), accelerator: WIDEN_KEY, onSelect: () => stepResize(KEYBOARD_RESIZE_STEP) }] : []),
    ],
  } : null), [!!resize, canNarrow, canWiden, width]);

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
        ref={sidebarRef}
        width={width}
        height={sidebarLayoutHeight}
        flexDirection="row"
        position="relative"
        style={nativeFillStyle}
        data-gloom-role="pane-sidebar"
      >
        <Box
          // The desktop list fills the sidebar, so it follows a drag of its box.
          width={nativePaneChrome ? "100%" : listWidth}
          height={sidebarLayoutHeight}
          flexDirection="column"
          backgroundColor={backgroundColor}
          overflow={nativePaneChrome ? "hidden" : undefined}
          style={nativePaneChrome ? { minHeight: 0, overflow: "hidden" } : undefined}
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
          // A 1px line is too thin to grab, so the handle straddles it, above
          // what sits beside the sidebar (a table's header and rows are
          // positioned, and would take the half of it over them).
          <Box
            ref={dividerRef}
            position="absolute"
            top={0}
            right={0}
            width={1}
            height={sidebarLayoutHeight}
            {...resizeHandlers}
            title={`${t("Resize sidebar")} (${NARROW_KEY} ${WIDEN_KEY})`}
            style={{
              width: 1 + DESKTOP_RESIZE_HANDLE_PADDING_PX * 2,
              right: -DESKTOP_RESIZE_HANDLE_PADDING_PX,
              height: "100%",
              zIndex: 3,
              cursor: "col-resize",
            }}
          />
        )}
      </Box>
    </PaneSidebarContext.Provider>
  );
}

export function PaneSidebarList({ children }: { children: ReactNode }) {
  const { nativePaneChrome } = useUiCapabilities();
  return (
    <Box
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minHeight={0}
      overflow={nativePaneChrome ? undefined : "hidden"}
      data-gloom-role="pane-sidebar-list"
      style={nativePaneChrome ? { minHeight: 0, overflowX: "hidden", overflowY: "auto" } : undefined}
    >
      {children}
    </Box>
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
