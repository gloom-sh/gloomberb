import { DataTableView, Notice, useTableLayoutWidth, type DataTableColumn } from "../../../components";
import { turbo } from "../../../components/chart/surface3d/model";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text } from "../../../ui";
import { deltaLabel, tenorLabel, type SurfaceCell, type VolatilitySurfaceGrid } from "./raster";

/** The vol range the 3D surface colours and its legend span. */
interface SurfaceColorRange { zMin: number; zMax: number }

const CELL_WIDTH = 6;
const LABEL_WIDTH = 7;
/** Table padding and the gap after each column, so a column takes its width plus one. */
const TABLE_INSET = 2;
const LEGEND_STEPS = 24;

const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0");

/** The 3D mesh's colour for an implied vol, as a hex string: the same turbo scale over the same range. */
export function surfaceColorHex(value: number, range: SurfaceColorRange): string {
  const color = turbo((value - range.zMin) / Math.max(range.zMax - range.zMin, 1e-9));
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Dark text on the bright half of the scale, light text on the dark end. */
export function surfaceTextColor(hex: string): string {
  const red = Number.parseInt(hex.slice(1, 3), 16), green = Number.parseInt(hex.slice(3, 5), 16), blue = Number.parseInt(hex.slice(5, 7), 16);
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 > 0.45 ? "#101010" : "#f4f4f4";
}

/**
 * The columns a grid of this width shows: all of them when they fit, else an
 * even sample from the put wing to the call wing that always keeps ATM.
 */
export function heatGridColumns(coordinates: readonly number[], width: number): number[] {
  const fit = Math.max(1, Math.floor((width - TABLE_INSET - LABEL_WIDTH - 1) / (CELL_WIDTH + 1)));
  if (coordinates.length <= fit) return coordinates.map((_, index) => index);
  const atm = coordinates.findIndex((value) => Math.abs(value) < 1e-9);
  const picked = new Set(Array.from({ length: fit }, (_, slot) => fit === 1 ? Math.floor(coordinates.length / 2)
    : Math.round(slot * (coordinates.length - 1) / (fit - 1))));
  if (atm >= 0 && !picked.has(atm)) {
    const nearest = [...picked].reduce((best, index) => Math.abs(index - atm) < Math.abs(best - atm) ? index : best);
    picked.delete(nearest);
    picked.add(atm);
  }
  return [...picked].sort((a, b) => a - b);
}

interface HeatRow { index: number; label: string }

/** Days up to the first few months, so neighbouring expiries do not all read "1M". */
export function heatGridTenorLabel(years: number): string {
  const days = Math.round(years * 365);
  return days > 0 && days < 100 ? `${days}D` : tenorLabel(years);
}

export interface SurfaceHeatGridProps {
  grid: VolatilitySurfaceGrid;
  range: SurfaceColorRange;
  /** Four to six round vol levels the legend names, as the 3D box does. */
  ticks: readonly { value: number; label: string }[];
  selected: SurfaceCell | null;
  onSelect: (cell: SurfaceCell) => void;
  width: number;
  height: number;
  /** Why the grid stands where the 3D surface would be. */
  notice?: string;
}

/**
 * The surface as a grid for views that cannot draw it in 3D: expiries down the
 * side, deltas across the top, each cell coloured on the surface's own scale
 * with the same legend. Drawn with the kit's table, so it works in every
 * renderer and the mouse picks a cell as it does on the 3D sheet.
 */
export function SurfaceHeatGrid({ grid, range, ticks, selected, onSelect, width, height, notice }: SurfaceHeatGridProps) {
  const colors = useThemeColors();
  const layoutWidth = useTableLayoutWidth(width);
  const shown = heatGridColumns(grid.moneyness, layoutWidth);
  const columns: DataTableColumn[] = [{ id: "tenor", label: "Expiry", width: LABEL_WIDTH, align: "left" },
    ...shown.map((column) => ({ id: String(column), label: grid.axis === "delta" ? deltaLabel(grid.moneyness[column]!) : `${Math.round(grid.moneyness[column]! * 100)}%`,
      width: CELL_WIDTH, align: "right" as const }))];
  const rows: HeatRow[] = grid.tenors.map((years, index) => ({ index,
    label: grid.rows?.[index]?.interpolated ? grid.rows[index]!.label : heatGridTenorLabel(years) }));
  const noticeRows = notice ? 1 : 0;
  const first = ticks[0], last = ticks.at(-1);
  return <Box flexDirection="column" width={width} height={height} data-gloom-role="surface-grid" data-gloom-surface-renderer="grid">
    {notice ? <Box paddingX={1}><Notice tone="muted">{notice}</Notice></Box> : null}
    <DataTableView<HeatRow> rootWidth={width} rootHeight={Math.max(2, height - 1 - noticeRows)} columns={columns} items={rows}
      getItemKey={(row) => String(row.index)}
      selection={{ kind: "id", selectedId: selected ? String(selected.tenorIndex) : null, getId: (row) => String(row.index),
        onChange: (_id, row) => onSelect({ tenorIndex: row.index, moneynessIndex: selected?.moneynessIndex ?? 0 }) }}
      onActivate={(row) => onSelect({ tenorIndex: row.index, moneynessIndex: selected?.moneynessIndex ?? 0 })} freezeFirstColumn
      sortColumnId={null} sortDirection="asc"
      renderCell={(row, column) => {
        if (column.id === "tenor") return { text: row.label, color: colors.textDim };
        const index = Number(column.id), value = grid.volatilities[row.index]?.[index] ?? null;
        const chosen = selected?.tenorIndex === row.index && selected.moneynessIndex === index;
        const onMouseDown = () => onSelect({ tenorIndex: row.index, moneynessIndex: index });
        if (value == null || !Number.isFinite(value)) return { text: "--", color: colors.textMuted, onMouseDown };
        const fill = surfaceColorHex(value, range);
        return { text: (value * 100).toFixed(1), color: chosen ? colors.selectedText : surfaceTextColor(fill),
          backgroundColor: chosen ? colors.selected : fill, onMouseDown };
      }} emptyStateTitle="No volatility observations." />
    <Box flexDirection="row" height={1} gap={1} paddingX={1} flexShrink={0} data-gloom-role="surface-legend">
      <Box flexShrink={0}><Text fg={colors.textDim}>{first?.label ?? ""}</Text></Box>
      <Box flexDirection="row" width={LEGEND_STEPS} height={1} flexShrink={0}>
        {Array.from({ length: LEGEND_STEPS }, (_, step) => (
          <Box key={step} width={1} height={1} flexShrink={0}
            backgroundColor={surfaceColorHex(range.zMin + (range.zMax - range.zMin) * (step / (LEGEND_STEPS - 1)), range)} />))}
      </Box>
      <Box flexShrink={0}><Text fg={colors.textDim}>{last?.label ?? ""}</Text></Box>
    </Box>
  </Box>;
}
