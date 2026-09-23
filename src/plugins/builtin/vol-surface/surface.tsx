import { useMemo, type ReactNode } from "react";
import { Surface3DChart } from "../../../components/chart/surface3d/chart";
import { volatilitySurfaceInput, type SurfaceCamera, type SurfaceCell, type VolatilitySurfaceGrid } from "./raster";

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
  const input = useMemo(() => volatilitySurfaceInput(props.grid, props.selected),
    [props.grid, props.selected?.tenorIndex, props.selected?.moneynessIndex]);
  return <Surface3DChart input={input} camera={props.camera} onCameraChange={props.onCameraChange}
    onSelect={(cell) => props.onSelect({ tenorIndex: cell.row, moneynessIndex: cell.column })}
    width={props.width} height={props.height} ariaLabel="Implied volatility surface" fallback={props.fallback} />;
}
