import { useMemo, useRef, type ReactNode } from "react";
import { Surface3DChart } from "../../../components/chart/surface3d/chart";
import { volatilitySurfaceInput, type SurfaceCamera, type SurfaceCell, type SurfaceZRange, type VolatilitySurfaceGrid } from "./raster";

export interface VolatilitySurfaceProps {
  grid: VolatilitySurfaceGrid;
  camera: SurfaceCamera;
  onCameraChange: (camera: SurfaceCamera) => void;
  selected: SurfaceCell | null;
  onSelect: (cell: SurfaceCell) => void;
  width: number;
  height: number;
  /** The pane's shared shaded table remains usable without a bitmap renderer. */
  fallback?: ReactNode;
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
  return <Surface3DChart input={input} camera={props.camera} onCameraChange={props.onCameraChange}
    onSelect={(cell) => props.onSelect({ tenorIndex: cell.row, moneynessIndex: cell.column })}
    width={props.width} height={props.height} ariaLabel="Implied volatility surface" fallback={props.fallback} />;
}
