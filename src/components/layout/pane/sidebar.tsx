import { createContext, startTransition, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Box, Text, useNativeRenderer, useUiCapabilities, useUiHost, type BoxRenderable, type ScrollBoxRenderable } from "../../../ui";
import { afterLayout, revealInScrollBox } from "../../ui/reveal-in-scroll-box";
import { observeScrollBoxContentSize, observeScrollBoxViewportSize } from "../../../renderers/opentui/scrollbox-layout";
import { beginLiveResize, createCatchUp, type CatchUp } from "../../../ui/live-resize";
import { capturePointerDrag } from "../../../ui/pointer-drag";
import { blendHex, colors, hoverBg, inactiveSelectedBg } from "../../../theme/colors";
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
/** Cells one press of `<` or `>` moves the divider: enough to see it move. */
const KEYBOARD_RESIZE_STEP = 4;
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
  if (!context) throw new Error("PaneSidebarList, PaneSidebarRow and PaneSidebarAction must be rendered inside PaneSidebar.");
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

  // The keyboard moves the divider too: `<` and `>` while the pane is focused.
  // They are bound and listed in the pane menu, not drawn in the footer: the
  // width of a list is not one of the pane's actions, and the divider shows
  // where it is (on the desktop its tooltip names the keys). Each press is a
  // finished resize, so it persists.
  const resizeRegistrationId = `pane-sidebar-resize:${useId()}`;
  const canNarrow = !!resize && width > resize.min;
  const canWiden = !!resize && width < resize.max;
  const stepResize = (delta: number) => {
    if (!resize) return;
    const next = Math.min(resize.max, Math.max(resize.min, width + delta));
    if (next !== width) (resize.onResizeEnd ?? resize.onResize)(next);
  };
  usePaneFooter(resizeRegistrationId, () => {
    if (!resize) return null;
    const steps = [
      { id: "sidebar-narrow", key: NARROW_KEY, title: "Narrow Sidebar", delta: -KEYBOARD_RESIZE_STEP, disabled: !canNarrow },
      { id: "sidebar-widen", key: WIDEN_KEY, title: "Widen Sidebar", delta: KEYBOARD_RESIZE_STEP, disabled: !canWiden },
    ];
    return {
      // After the pane's own actions, which register at order 0.
      order: 1,
      keys: steps.map(({ id, key, delta, disabled }) => ({ id, key, label: "", onPress: () => stepResize(delta), disabled })),
      // A bound that is reached drops out, as a disabled footer hint did.
      menu: steps.filter((step) => !step.disabled).map(({ id, key, title, delta }) => ({
        id: `pane-sidebar:${id}`,
        label: title,
        accelerator: key,
        onSelect: () => stepResize(delta),
      })),
    };
  }, [!!resize, canNarrow, canWiden, resize?.min, resize?.max, width]);

  const borderWidth = nativePaneChrome ? 0 : width > 1 ? 1 : 0;
  const listWidth = Math.max(width - borderWidth, 1);
  const dividerColor = focused ? colors.borderFocused : colors.border;
  const backgroundColor = keyboardFocused
    ? blendHex(colors.panel, colors.borderFocused, 0.18)
    : colors.panel;
  const activeBackgroundColor = keyboardFocused
    ? blendHex(colors.selected, colors.borderFocused, 0.32)
    : inactiveSelectedBg(colors);
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

interface PaneSidebarListContextValue {
  /** Marks `node` as the row the list keeps in view, and brings it there. */
  setCurrent: (node: BoxRenderable | null) => void;
}

const PaneSidebarListContext = createContext<PaneSidebarListContextValue | null>(null);

/**
 * Keeps the row `ref` is on in view while it is `current`: the row the
 * keyboard is on, or the open item. Rows outside a PaneSidebarList, and the
 * desktop list, which scrolls by CSS, ignore it.
 */
export function usePaneSidebarReveal(ref: RefObject<BoxRenderable | null>, current: boolean): void {
  const list = useContext(PaneSidebarListContext);
  useLayoutEffect(() => {
    if (!list || !current) return;
    list.setCurrent(ref.current);
    return () => list.setCurrent(null);
  }, [current, list, ref]);
}

export interface PaneSidebarListRenderState {
  /** The width a row has beside the list's scrollbar, while it shows one. */
  listWidth: number;
}

/**
 * The scrolling part of a sidebar. The wheel scrolls it, a scrollbar shows
 * while it holds more rows than fit, and the row a `PaneSidebarRow` marks
 * `active` (or `usePaneSidebarReveal` marks current) stays in view as the
 * keyboard moves it.
 */
export function PaneSidebarList({ children }: { children: ReactNode | ((state: PaneSidebarListRenderState) => ReactNode) }) {
  const { nativePaneChrome } = useUiCapabilities();
  const sidebar = usePaneSidebarContext();
  if (nativePaneChrome) {
    return (
      <Box
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
        data-gloom-role="pane-sidebar-list"
        style={{ minHeight: 0, overflowX: "hidden", overflowY: "auto" }}
      >
        {typeof children === "function" ? children({ listWidth: sidebar.listWidth }) : children}
      </Box>
    );
  }
  return <TerminalPaneSidebarList sidebar={sidebar}>{children}</TerminalPaneSidebarList>;
}

function TerminalPaneSidebarList({ sidebar, children }: {
  sidebar: PaneSidebarContextValue;
  children: ReactNode | ((state: PaneSidebarListRenderState) => ReactNode);
}) {
  // The host's own ScrollBox, which the pane scroll keys do not drive: the
  // list's keys move its cursor, and the pane's bring the cursor into view.
  const { ScrollBox } = useUiHost();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const currentRef = useRef<BoxRenderable | null>(null);
  const [scrollbar, setScrollbar] = useState(false);
  const reveal = useCallback(() => afterLayout(() => revealInScrollBox(scrollRef.current, currentRef.current)), []);
  const list = useMemo<PaneSidebarListContextValue>(() => ({
    setCurrent: (node) => {
      currentRef.current = node;
      if (node) reveal();
    },
  }), [reveal]);
  // The scrollbar shows once the rows outgrow the list, and takes a column
  // from them. Read once the whole pass is laid out: the content is at least
  // as tall as the viewport, and is not yet sized to it when the viewport
  // reports.
  const syncScrollbar = useCallback(() => afterLayout(() => {
    const scrollBox = scrollRef.current;
    if (!scrollBox) return;
    const viewportHeight = scrollBox.viewport?.height ?? 0;
    setScrollbar(viewportHeight > 0 && scrollBox.scrollHeight > viewportHeight);
  }), []);
  // A list that opens, or is made shorter or taller, brings the row under the
  // cursor back into view. Rows coming and going, and the scrollbar taking a
  // column, leave the scroll where the wheel put it.
  const viewportHeightRef = useRef(0);
  const syncViewport = useCallback(() => {
    syncScrollbar();
    const height = scrollRef.current?.viewport?.height ?? 0;
    if (height === viewportHeightRef.current) return;
    viewportHeightRef.current = height;
    reveal();
  }, [reveal, syncScrollbar]);
  useEffect(() => observeScrollBoxViewportSize(scrollRef.current, syncViewport), [syncViewport]);
  useEffect(() => observeScrollBoxContentSize(scrollRef.current, syncScrollbar), [syncScrollbar]);
  // In the same frame as the rows narrow or widen for it.
  useLayoutEffect(() => {
    const bar = scrollRef.current?.verticalScrollBar;
    if (bar) bar.visible = scrollbar;
  }, [scrollbar]);
  const listWidth = Math.max(1, sidebar.listWidth - (scrollbar ? 1 : 0));
  const context = useMemo(() => ({ ...sidebar, listWidth }), [sidebar, listWidth]);

  return (
    <PaneSidebarContext.Provider value={context}>
      <PaneSidebarListContext.Provider value={list}>
        <ScrollBox
          ref={scrollRef}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minHeight={0}
          scrollY
          focusable={false}
          verticalScrollbarOptions={{ visible: false }}
          horizontalScrollbarOptions={{ visible: false }}
          data-gloom-role="pane-sidebar-list"
        >
          {typeof children === "function" ? children({ listWidth }) : children}
        </ScrollBox>
      </PaneSidebarListContext.Provider>
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
  const rowRef = useRef<BoxRenderable>(null);
  usePaneSidebarReveal(rowRef, active);
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
      ref={rowRef}
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
