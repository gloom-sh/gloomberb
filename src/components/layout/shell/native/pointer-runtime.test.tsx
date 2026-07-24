import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getDockLeafLayouts,
  type LayoutBounds,
  type ResolvedPane,
} from "../../../../plugins/pane-manager";
import { createPaneInstance, type LayoutConfig } from "../../../../types/config";
import { useShellActiveDrag } from "../active-drag";
import {
  constrainFloatingRectToBounds,
  makeSnapGuides,
  resolveHoverOverlay,
} from "../drag";
import type { ShellDragRuntimeState, ShellMouseEvent } from "../drag/runtime";
import { useShellNativePointerRuntime } from "./pointer-runtime";

type NativePointerRuntime = ReturnType<typeof useShellNativePointerRuntime>;

function createMouseDown(): ShellMouseEvent & { defaultPrevented: boolean; propagationStopped: boolean } {
  return {
    type: "down",
    x: 20,
    y: 5,
    button: 0,
    preciseX: 20,
    preciseY: 5,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
}

function createPointerEvent(
  type: "down" | "drag" | "drag-end",
  x: number,
  preciseY: number,
): ShellMouseEvent & { defaultPrevented: boolean; propagationStopped: boolean } {
  return {
    type,
    x,
    y: preciseY,
    button: 0,
    preciseX: x,
    preciseY,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
}

function createDragRuntime(): ShellDragRuntimeState {
  const dragRef = { current: null } as ShellDragRuntimeState["dragRef"];
  const dividerPreviewRef = { current: null } as ShellDragRuntimeState["dividerPreviewRef"];
  const dockPreviewRef = { current: null } as ShellDragRuntimeState["dockPreviewRef"];
  const dragRuntime: ShellDragRuntimeState = {
    cancelActiveDrag() {
      dragRef.current = null;
      dividerPreviewRef.current = null;
      dockPreviewRef.current = null;
    },
    dividerPreview: null,
    dividerPreviewRef,
    dockPreview: null,
    dockPreviewRef,
    dragCursor: null,
    dragFloatingRect: null,
    dragRef,
    hasActiveDrag: () => dragRef.current != null,
    setDragCursor() {},
    updateDividerPreview(next) { dividerPreviewRef.current = next; },
    updateDockPreview(next) { dockPreviewRef.current = next; },
    updateDragFloatingRect(next) { dragRuntime.dragFloatingRect = next; },
  };
  return dragRuntime;
}

const NATIVE_BOUNDS: LayoutBounds = { x: 0, y: 0, width: 120, height: 60 };
const NATIVE_APP_HEADER_HEIGHT = 28 / 18;

function paneMapFor(layout: LayoutConfig): Map<string, ResolvedPane> {
  return new Map(layout.instances.map((instance): [string, ResolvedPane] => {
    const floating = layout.floating.find((entry) => entry.instanceId === instance.instanceId);
    return [instance.instanceId, {
      instance,
      def: {
        id: instance.paneId,
        name: instance.paneId,
        component: () => null,
        defaultPosition: "left",
      },
      ...(floating ? { floating } : {}),
    }];
  }));
}

function renderIntegratedPointerRuntime(layout: LayoutConfig) {
  const dragRuntime = createDragRuntime();
  const persistedLayouts: LayoutConfig[] = [];
  const focusedPaneIds: string[] = [];
  let runtime: NativePointerRuntime | undefined;
  const dockLeafLayouts = getDockLeafLayouts(layout, NATIVE_BOUNDS, { precise: true });

  function Harness() {
    const handleActiveDrag = useShellActiveDrag({
      appHeaderHeight: NATIVE_APP_HEADER_HEIGHT,
      bounds: NATIVE_BOUNDS,
      contentHeight: NATIVE_BOUNDS.height,
      dispatch() {},
      dockGeometryOptions: { precise: true },
      dockLeafLayouts,
      dragRuntime,
      focusPane(paneId) { focusedPaneIds.push(paneId); },
      nativePaneChrome: true,
      paneMap: paneMapFor(layout),
      persistLayout(nextLayout) { persistedLayouts.push(nextLayout); },
      precisePointer: true,
      snapGuides: makeSnapGuides(NATIVE_BOUNDS.width, NATIVE_BOUNDS.height),
      updateWindowModePreviewLayout() {},
      visibleLayout: layout,
      width: NATIVE_BOUNDS.width,
      windowMode: null,
    });
    runtime = useShellNativePointerRuntime({
      appHeaderHeight: NATIVE_APP_HEADER_HEIGHT,
      dragRuntime,
      focusPane(paneId) { focusedPaneIds.push(paneId); },
      handleActiveDrag,
      handleFloatingClose() {},
      menuState: null,
      nativePaneChrome: true,
      openPaneMenu() {},
      selectWindowModePane() {},
      setHoveredMenuItemId() {},
      setMenuState() {},
      transientFocusActive: false,
      togglePaneFloating: () => true,
      windowMode: null,
    });
    return null;
  }

  renderToStaticMarkup(<Harness />);
  if (!runtime) throw new Error("integrated native pointer runtime was not captured");
  return { dockLeafLayouts, dragRuntime, focusedPaneIds, persistedLayouts, runtime };
}

function overlayCellCenter(
  layout: LayoutConfig,
  draggedPaneId: string,
  targetPaneId: string,
  position: "top" | "left" | "center" | "right" | "bottom",
) {
  const leaves = getDockLeafLayouts(layout, NATIVE_BOUNDS, { precise: true });
  const target = leaves.find((leaf) => leaf.instanceId === targetPaneId);
  if (!target) throw new Error(`missing target pane ${targetPaneId}`);
  const overlay = resolveHoverOverlay(
    target.rect.x + (target.rect.width / 2),
    target.rect.y + (target.rect.height / 2),
    leaves,
    draggedPaneId,
  );
  const cell = overlay?.cells.find((entry) => entry.position === position);
  if (!cell) throw new Error(`missing ${position} overlay cell`);
  return {
    x: cell.rect.x + (cell.rect.width / 2),
    shellY: cell.rect.y + (cell.rect.height / 2),
  };
}

function renderPointerRuntime(): {
  dragRef: ShellDragRuntimeState["dragRef"];
  runtime: NativePointerRuntime;
  toggledPaneIds: string[];
} {
  const dragRef = { current: null } as ShellDragRuntimeState["dragRef"];
  const dragRuntime = {
    dragRef,
    updateDividerPreview() {},
    updateDockPreview() {},
    updateDragFloatingRect() {},
  } as unknown as ShellDragRuntimeState;
  let runtime: NativePointerRuntime | undefined;
  const toggledPaneIds: string[] = [];

  function Harness() {
    runtime = useShellNativePointerRuntime({
      appHeaderHeight: 1,
      dragRuntime,
      focusPane() {},
      handleActiveDrag() {},
      handleFloatingClose() {},
      menuState: null,
      nativePaneChrome: true,
      openPaneMenu() {},
      selectWindowModePane() {},
      setHoveredMenuItemId() {},
      setMenuState() {},
      transientFocusActive: false,
      togglePaneFloating(paneId) {
        toggledPaneIds.push(paneId);
        return true;
      },
      windowMode: null,
    });
    return null;
  }

  renderToStaticMarkup(<Harness />);
  if (!runtime) throw new Error("native pointer runtime was not captured");
  return { dragRef, runtime, toggledPaneIds };
}

describe("useShellNativePointerRuntime", () => {
  test("routes floating and docked header mousedown to move, and border mousedown to resize", () => {
    const { dragRef, runtime } = renderPointerRuntime();
    const floatingRect = { x: 8, y: 2, width: 32, height: 10 };
    const dockedRect = { x: 0, y: 0, width: 40, height: 17 };

    const floatingHeaderDown = createMouseDown();
    runtime.startNativeFloatingDrag("floating:main", floatingRect, floatingHeaderDown);
    expect(dragRef.current).toEqual(expect.objectContaining({
      type: "pane-drag",
      paneId: "floating:main",
      mode: "floating",
    }));
    expect(floatingHeaderDown.defaultPrevented).toBe(true);
    expect(floatingHeaderDown.propagationStopped).toBe(false);

    const dockedHeaderDown = createMouseDown();
    runtime.startNativeDockedDrag("docked:main", dockedRect, dockedHeaderDown);
    expect(dragRef.current).toEqual(expect.objectContaining({
      type: "pane-drag",
      paneId: "docked:main",
      mode: "docked",
    }));
    expect(dockedHeaderDown.defaultPrevented).toBe(true);
    expect(dockedHeaderDown.propagationStopped).toBe(false);

    for (const corner of [
      "top-left",
      "top",
      "top-right",
      "left",
      "right",
      "bottom-left",
      "bottom",
      "bottom-right",
    ] as const) {
      const resizeDown = createMouseDown();
      runtime.startNativeFloatResize("floating:main", floatingRect, corner, resizeDown);
      expect(dragRef.current).toEqual(expect.objectContaining({
        type: "float-resize",
        paneId: "floating:main",
        corner,
      }));
      expect(resizeDown.defaultPrevented).toBe(true);
      expect(resizeDown.propagationStopped).toBe(true);
    }
  });

  test("previews and commits a native top-edge resize without changing x or width", () => {
    const floatingRect = {
      instanceId: "floating:main",
      x: 20,
      y: 10,
      width: 40,
      height: 20,
      zIndex: 75,
    };
    const layout: LayoutConfig = {
      dockRoot: null,
      instances: [createPaneInstance("floating", { instanceId: floatingRect.instanceId })],
      floating: [floatingRect],
      detached: [],
    };
    const { dragRuntime, persistedLayouts, runtime } = renderIntegratedPointerRuntime(layout);
    const pointerX = floatingRect.x + (floatingRect.width / 2);
    const resizedTop = floatingRect.y - 3;
    const down = createPointerEvent(
      "down",
      pointerX,
      floatingRect.y + NATIVE_APP_HEADER_HEIGHT,
    );

    runtime.startNativeFloatResize(floatingRect.instanceId, floatingRect, "top", down);
    expect(dragRuntime.dragRef.current).toEqual(expect.objectContaining({
      type: "float-resize",
      paneId: floatingRect.instanceId,
      corner: "top",
    }));

    const move = createPointerEvent("drag", pointerX, resizedTop + NATIVE_APP_HEADER_HEIGHT);
    runtime.handleNativeDrag(move);
    expect(dragRuntime.dragFloatingRect).toEqual({
      paneId: floatingRect.instanceId,
      rect: {
        x: floatingRect.x,
        y: resizedTop,
        width: floatingRect.width,
        height: floatingRect.height + 3,
        zIndex: floatingRect.zIndex,
        fixedGeometry: undefined,
      },
    });

    const release = createPointerEvent("drag-end", pointerX, resizedTop + NATIVE_APP_HEADER_HEIGHT);
    runtime.handleNativeDrag(release);

    expect(persistedLayouts).toHaveLength(1);
    expect(persistedLayouts[0]!.floating[0]).toMatchObject({
      instanceId: floatingRect.instanceId,
      x: floatingRect.x,
      y: resizedTop,
      width: floatingRect.width,
      height: floatingRect.height + 3,
    });
    expect(dragRuntime.dragFloatingRect).toBeNull();
    expect(dragRuntime.dragRef.current).toBeNull();
    expect(release.defaultPrevented).toBe(true);
    expect(release.propagationStopped).toBe(true);
  });

  test("keeps the small float toggle isolated from the header move grab", () => {
    const { dragRef, runtime, toggledPaneIds } = renderPointerRuntime();
    const toggleDown = createMouseDown();

    runtime.handlePaneFloatToggle("docked:main", toggleDown);

    expect(toggledPaneIds).toEqual(["docked:main"]);
    expect(toggleDown.defaultPrevented).toBe(true);
    expect(toggleDown.propagationStopped).toBe(true);
    expect(dragRef.current).toBeNull();
  });

  for (const operation of [
    { position: "top" as const, axis: "vertical" as const, order: ["source:main", "target:main"] },
    { position: "left" as const, axis: "horizontal" as const, order: ["source:main", "target:main"] },
    { position: "right" as const, axis: "horizontal" as const, order: ["target:main", "source:main"] },
    { position: "bottom" as const, axis: "vertical" as const, order: ["target:main", "source:main"] },
  ]) {
    test(`runs native header move, ${operation.position} hover, and release through the shared operator`, () => {
      const layout: LayoutConfig = {
        dockRoot: {
          kind: "split",
          axis: "horizontal",
          ratio: 0.5,
          first: { kind: "pane", instanceId: "source:main" },
          second: { kind: "pane", instanceId: "target:main" },
        },
        instances: [
          createPaneInstance("source", { instanceId: "source:main" }),
          createPaneInstance("target", { instanceId: "target:main" }),
        ],
        floating: [],
        detached: [],
      };
      const { dockLeafLayouts, dragRuntime, focusedPaneIds, persistedLayouts, runtime } = renderIntegratedPointerRuntime(layout);
      const sourceRect = dockLeafLayouts.find((leaf) => leaf.instanceId === "source:main")!.rect;
      const pointer = overlayCellCenter(layout, "source:main", "target:main", operation.position);
      const down = createPointerEvent("down", sourceRect.x + 2, sourceRect.y + NATIVE_APP_HEADER_HEIGHT + 1);

      runtime.startNativeDockedDrag("source:main", sourceRect, down);
      expect(dragRuntime.dragRef.current).toEqual(expect.objectContaining({
        type: "pane-drag",
        mode: "docked",
      }));
      expect(dragRuntime.dragRef.current?.startY).toBeCloseTo(sourceRect.y + 1);

      const move = createPointerEvent("drag", pointer.x, pointer.shellY + NATIVE_APP_HEADER_HEIGHT);
      runtime.handleNativeDrag(move);
      const preview = dragRuntime.dockPreviewRef.current;
      expect(preview).toMatchObject({
        kind: "dock",
        target: { kind: "leaf", targetId: "target:main", position: operation.position },
      });
      expect(move.defaultPrevented).toBe(true);
      expect(move.propagationStopped).toBe(true);

      const release = createPointerEvent("drag-end", pointer.x, pointer.shellY + NATIVE_APP_HEADER_HEIGHT);
      runtime.handleNativeDrag(release);

      expect(persistedLayouts).toHaveLength(1);
      expect(persistedLayouts[0]).toEqual(preview!.layout);
      expect(persistedLayouts[0]!.dockRoot).toMatchObject({
        kind: "split",
        axis: operation.axis,
        first: { kind: "pane", instanceId: operation.order[0] },
        second: { kind: "pane", instanceId: operation.order[1] },
      });
      expect(focusedPaneIds.at(-1)).toBe("source:main");
      expect(dragRuntime.dragRef.current).toBeNull();
      expect(release.defaultPrevented).toBe(true);
      expect(release.propagationStopped).toBe(true);
    });
  }

  test("center-drops a snapped floating pane onto a docked pane through native preview and release", () => {
    const snappedRect = {
      instanceId: "source:main",
      x: 80,
      y: 4,
      width: 6,
      height: 6,
      zIndex: 75,
      fixedGeometry: true,
    };
    const layout: LayoutConfig = {
      dockRoot: { kind: "pane", instanceId: "target:main" },
      instances: [
        createPaneInstance("source", { instanceId: "source:main" }),
        createPaneInstance("target", { instanceId: "target:main" }),
      ],
      floating: [snappedRect],
      detached: [],
    };
    const { dragRuntime, persistedLayouts, runtime } = renderIntegratedPointerRuntime(layout);
    const pointer = overlayCellCenter(layout, "source:main", "target:main", "center");
    const down = createPointerEvent(
      "down",
      snappedRect.x + 1,
      snappedRect.y + NATIVE_APP_HEADER_HEIGHT + 1,
    );

    runtime.startNativeFloatingDrag("source:main", snappedRect, down);
    const move = createPointerEvent("drag", pointer.x, pointer.shellY + NATIVE_APP_HEADER_HEIGHT);
    runtime.handleNativeDrag(move);

    const preview = dragRuntime.dockPreviewRef.current;
    expect(preview).toMatchObject({
      kind: "dock",
      target: { kind: "leaf", targetId: "target:main", position: "center" },
      rect: NATIVE_BOUNDS,
    });
    expect(preview!.layout.floating).toEqual([
      { ...snappedRect, instanceId: "target:main" },
    ]);

    const release = createPointerEvent("drag-end", pointer.x, pointer.shellY + NATIVE_APP_HEADER_HEIGHT);
    runtime.handleNativeDrag(release);

    expect(persistedLayouts).toHaveLength(1);
    expect(persistedLayouts[0]).toEqual(preview!.layout);
    expect(getDockLeafLayouts(persistedLayouts[0]!, NATIVE_BOUNDS, { precise: true })).toEqual([
      { instanceId: "source:main", path: [], rect: NATIVE_BOUNDS },
    ]);
    const { instanceId: renderedInstanceId, ...renderedTarget } = constrainFloatingRectToBounds(
      persistedLayouts[0]!.floating[0]!,
      NATIVE_BOUNDS.width,
      NATIVE_BOUNDS.height,
    ) as typeof snappedRect;
    expect(renderedInstanceId).toBe("target:main");
    expect(renderedTarget).toEqual({
      x: snappedRect.x,
      y: snappedRect.y,
      width: snappedRect.width,
      height: snappedRect.height,
      zIndex: snappedRect.zIndex,
      fixedGeometry: true,
    });
    expect(dragRuntime.dragRef.current).toBeNull();
  });
});
