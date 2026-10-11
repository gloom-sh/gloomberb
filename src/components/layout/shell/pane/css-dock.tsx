import { memo, useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { Box, type BoxRenderable } from "../../../../ui";
import { clampRatio, DOCK_SPLIT_MIN_CELLS, type DockDividerLayout } from "../../../../layout/pane-manager";
import type { DockLayoutNode, DockSplitNode } from "../../../../types/config";
import { colors } from "../../../../theme/colors";
import { pathKey } from "../../window-edit/mode";
import { useLiveDrag, type LiveDragGeometry, type LiveDragStore } from "../drag/live";

/**
 * CSS layout spike (GLO-544, `ui/css-layout.ts`): the dock tree as nested flex
 * boxes, laid out by the browser. Each split is a row or a column whose first
 * child takes the split's ratio as its flex basis and whose second takes the
 * rest, so the panes fill the shell as `getDockLeafLayouts` lays them out in
 * precise mode, the same minimum either side included. A divider drag writes
 * the first child's flex basis outside React on every move; the browser lays
 * out everything under it, the divider (a zero-size flex item between the
 * two) moves with the boundary, and nothing renders. The release writes the
 * ratio to the layout as before, and the basis React renders from it is the
 * one the drag left.
 *
 * Pane identity: a pane rendered inside its branch is a different React
 * subtree once a swap or a dock moves it to another branch, so it mounts
 * again and loses its state (main's absolutely placed panes are siblings and
 * never do). Where the browser has CSS anchor positioning, the tree holds
 * only empty slots, each named as an anchor (`paneAnchor`), and the panes stay
 * flat siblings placed on their slot's edges by CSS (`anchoredPaneStyle`),
 * so they never remount. Otherwise they render inside the slots.
 */

/** Whether this browser places a box on another's edges by CSS (anchor positioning). */
export const CSS_ANCHORS = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("anchor-name: --a");

/** A dashed ident for a pane's slot: the instance id with anything but letters, digits, - and _ spelled out. */
function paneAnchor(instanceId: string): string {
  return `--gloom-pane-${instanceId.replace(/[^a-zA-Z0-9_-]/g, (char) => `_${char.charCodeAt(0)}_`)}`;
}

/** A flat pane over its slot in the tree: the slot's edges, by CSS. */
export function anchoredPaneStyle(instanceId: string) {
  const anchor = paneAnchor(instanceId);
  return {
    position: "absolute",
    top: `anchor(${anchor} top)`,
    left: `anchor(${anchor} left)`,
    right: `anchor(${anchor} right)`,
    bottom: `anchor(${anchor} bottom)`,
  } as const;
}

/** The divider strip, centered on the boundary: as `dividerSize` in the shell's precise dock geometry. */
const DIVIDER_PX = { horizontal: "var(--cell-w)", vertical: "min(var(--cell-h), 8px)" } as const;

/**
 * The first child's share of a split as a CSS flex basis: the split's ratio,
 * kept the minimum cells from either end, and half each when there is room for
 * neither (as `resolveSplitSizes` in precise mode).
 */
function splitBasis(axis: DockSplitNode["axis"], ratio: number): string {
  const min = axis === "horizontal"
    ? `calc(${DOCK_SPLIT_MIN_CELLS.horizontal} * var(--cell-w))`
    : `calc(${DOCK_SPLIT_MIN_CELLS.vertical} * var(--cell-h))`;
  return `clamp(min(${min}, 50%), ${clampRatio(ratio) * 100}%, max(calc(100% - ${min}), 50%))`;
}

interface CssDockDividerProps {
  divider: DockDividerLayout;
  live: LiveDragStore;
  /** Window mode is resizing this split from the keyboard. */
  resizing: boolean;
  onMouseDown: (divider: DockDividerLayout, event: any) => void;
  onDrag: (event: any) => void;
}

/** A split's divider: a zero-size flex item between its two sides, with its strip laid over the boundary. */
const CssDockDivider = memo(function CssDockDivider({
  axis,
  divider,
  live,
  resizing,
  onMouseDown,
  onDrag,
}: CssDockDividerProps & { axis: DockSplitNode["axis"] }) {
  const key = pathKey(divider.path);
  const selectDragged = useCallback((geometry: LiveDragGeometry) => geometry.divider?.pathKey === key, [key]);
  const active = useLiveDrag(live, selectDragged) || resizing;
  const size = DIVIDER_PX[axis];
  const strip = axis === "horizontal"
    ? { left: `calc(${size} / -2)`, top: 0, width: size, height: "100%" }
    : { top: `calc(${size} / -2)`, left: 0, width: "100%", height: size };
  return (
    <Box style={{ position: "relative", flex: "0 0 0px", minWidth: 0, minHeight: 0 }}>
      <Box
        position="absolute"
        zIndex={active ? 2 : 1}
        backgroundColor={active ? colors.borderFocused : colors.border}
        data-gloom-role="dock-divider"
        data-axis={axis}
        data-active={active ? "true" : "false"}
        style={{ ...strip, "--divider-color": active ? colors.borderFocused : colors.border } as any}
        onMouseDown={(event: any) => onMouseDown(divider, event)}
        onMouseDrag={onDrag}
        onMouseDragEnd={onDrag}
      />
    </Box>
  );
});

/** One side of a split: fills what the flex layout gives it, no less than nothing. */
const SIDE_STYLE = { position: "relative", display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" } as const;

interface CssDockProps {
  node: DockLayoutNode;
  path: Array<0 | 1>;
  live: LiveDragStore;
  /** The shell's dividers, by path key: what a press on one starts a drag with. */
  dividers: ReadonlyMap<string, DockDividerLayout>;
  /** Window mode's keyboard resize, by path key. */
  resizingPathKey: string | null;
  /** The pane inside its slot; null leaves the slot empty, as an anchor for a pane placed over it. */
  renderLeaf: ((instanceId: string) => ReactNode) | null;
  onDividerMouseDown: (divider: DockDividerLayout, event: any) => void;
  onDrag: (event: any) => void;
}

const CssDockSplit = memo(function CssDockSplit({ node, path, ...rest }: CssDockProps & { node: DockSplitNode }) {
  const { live, dividers, resizingPathKey, onDividerMouseDown, onDrag } = rest;
  const key = pathKey(path);
  const firstRef = useRef<BoxRenderable | null>(null);
  // The only per-move work of a divider drag: this split's first side takes
  // the ratio the pointer has. Null hands it back to the rendered ratio.
  useLayoutEffect(() => {
    let drawn: number | null = null;
    const follow = () => {
      const divider = live.get().divider;
      const ratio = divider?.pathKey === key ? divider.ratio : null;
      if (ratio === drawn) return;
      drawn = ratio;
      firstRef.current?.setLiveStyle?.(ratio === null ? null : { flexBasis: splitBasis(node.axis, ratio) });
    };
    follow();
    return live.subscribeMotion(follow);
  }, [key, live, node.axis]);
  const divider = dividers.get(key);
  return (
    <Box
      flexDirection={node.axis === "horizontal" ? "row" : "column"}
      style={{ position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
      data-gloom-role="css-dock-split"
    >
      <Box ref={firstRef} style={{ ...SIDE_STYLE, flexGrow: 0, flexShrink: 0, flexBasis: splitBasis(node.axis, node.ratio) }}>
        <CssDockNode {...rest} node={node.first} path={[...path, 0]} />
      </Box>
      {divider ? (
        <CssDockDivider
          axis={node.axis}
          divider={divider}
          live={live}
          resizing={resizingPathKey === key}
          onMouseDown={onDividerMouseDown}
          onDrag={onDrag}
        />
      ) : null}
      <Box style={{ ...SIDE_STYLE, flexGrow: 1, flexShrink: 1, flexBasis: "0px" }}>
        <CssDockNode {...rest} node={node.second} path={[...path, 1]} />
      </Box>
    </Box>
  );
});

function CssDockNode(props: CssDockProps) {
  if (props.node.kind === "pane") {
    if (props.renderLeaf) return <>{props.renderLeaf(props.node.instanceId)}</>;
    return <Box style={{ width: "100%", height: "100%", anchorName: paneAnchor(props.node.instanceId) } as any} />;
  }
  return <CssDockSplit {...props} node={props.node} />;
}

/**
 * The docked panes and their dividers over the shell's content area (`width`
 * by `height` cells, the bounds the rest of the shell lays out and hit tests
 * against).
 */
export function CssDockTree({ width, height, ...props }: Omit<CssDockProps, "path"> & { width: number; height: number }) {
  return (
    <Box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      style={{ display: "flex" }}
      data-gloom-role="css-dock"
    >
      <CssDockNode {...props} path={[]} />
    </Box>
  );
}
