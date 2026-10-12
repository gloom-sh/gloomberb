import { useMemo, useRef, type ReactNode } from "react";
import { PaneStatusBody } from "../../../components";
import { Surface3DChart } from "../../../components/chart/surface3d/chart";
import { buildSurface3DScene, type Surface3DCamera, type Surface3DInput } from "../../../components/chart/surface3d/model";
import { SurfaceHeatGrid } from "./heat-grid";
import { volatilitySurfaceInput, type SurfaceCell, type SurfaceZRange, type VolatilitySurfaceGrid } from "./raster";

export interface VolatilitySurfaceProps {
  grid: VolatilitySurfaceGrid;
  camera: Surface3DCamera;
  onCameraChange: (camera: Surface3DCamera) => void;
  selected: SurfaceCell | null;
  onSelect: (cell: SurfaceCell) => void;
  width: number;
  height: number;
  /** The pane's shared shaded table remains usable without a bitmap renderer. */
  fallback?: ReactNode;
  /** A load is still in flight: a sheet with nothing to draw yet waits instead of showing an empty box. */
  loading?: boolean;
  /** Whether this host draws the surface (a GPU or a bitmap); a terminal without one shows the fallback table as it always did. */
  meshAvailable?: boolean;
}

/** Whether the grid has a face to draw: two neighbouring expiries whose quotes overlap. One lone expiry, or cells that touch nothing, draw an empty box. */
function surfaceHasMesh(input: Surface3DInput): boolean {
  return buildSurface3DScene(input, 1).indices.length > 0;
}

/** Why the sheet cannot be drawn: how many of its expiries hold any value at all. */
function thinSurfaceNotice(quoted: number, rows: number): string {
  return `Usable quotes for ${quoted} of ${rows} expiries; a surface needs two neighbouring ones.`;
}

export function VolatilitySurface(props: VolatilitySurfaceProps) {
  // The box and colour scale carry over between reloads of the same shape.
  const heldRange = useRef<{ shape: string; range: SurfaceZRange } | null>(null);
  const input = useMemo(() => {
    const shape = `${props.grid.axis ?? "moneyness"}|${props.grid.tenors.length}|${props.grid.moneyness.join(",")}`;
    const next = volatilitySurfaceInput(props.grid, props.selected,
      heldRange.current?.shape === shape ? heldRange.current.range : null);
    heldRange.current = { shape, range: { zMin: next.zMin, zMax: next.zMax } };
    return next;
  }, [props.grid, props.selected?.tenorIndex, props.selected?.moneynessIndex]);
  const meshed = useMemo(() => surfaceHasMesh(input), [input]);
  const select = (cell: SurfaceCell) => props.onSelect(cell);
  if (props.meshAvailable && !meshed) {
    // Never an empty box: wait while quotes are still arriving, show what is quoted, or say there is none.
    if (props.loading) return <PaneStatusBody loading subject="volatility surface" />;
    const quoted = input.values.filter((row) => row.some((value) => value != null)).length;
    if (quoted === 0) {
      return <PaneStatusBody empty emptyTitle="No volatility to draw" emptyMessage={`None of the ${input.values.length} expiries has a usable quote.`} />;
    }
    return <SurfaceHeatGrid grid={props.grid} range={input} ticks={input.zTicks} selected={props.selected} onSelect={select}
      width={props.width} height={props.height} notice={thinSurfaceNotice(quoted, input.values.length)} />;
  }
  return <Surface3DChart input={input} camera={props.camera} onCameraChange={props.onCameraChange}
    onSelect={(cell) => select({ tenorIndex: cell.row, moneynessIndex: cell.column })}
    width={props.width} height={props.height} ariaLabel="Implied volatility surface" fallback={props.fallback} />;
}
