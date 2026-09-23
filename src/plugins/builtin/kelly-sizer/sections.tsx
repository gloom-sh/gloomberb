import { useMemo } from "react";
import {
  DataTableView,
  StaticChartSurface,
  type DataTableCell,
  type DataTableColumn,
  type StatItem,
} from "../../../components";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import type { StaticChartXMarker } from "../../../components/chart/static";
import { colors, priceColor } from "../../../theme/colors";
import { Box } from "../../../ui";
import { displayWidth, formatCurrency, formatNumber } from "../../../utils/format";
import type { KellySizingResult, SensitivityGrid } from "./model";
import { formatPct, formatSignedPct } from "./view";

/** The longest result label ("Full growth"), which sets the band's label column. */
const RESULT_LABEL_CHARS = 11;

/**
 * The sizing result as one band under the inputs, laid out in the FieldGrid's
 * columns: the Kelly fractions, then the move in money, then risk, then log
 * growth at full Kelly, at the current size and at the target.
 */
export function buildKellyResultItems({
  result,
  baseCurrency,
  currentGrowth,
  targetGrowth,
  width,
  columns,
}: {
  result: KellySizingResult;
  baseCurrency: string;
  currentGrowth: number;
  targetGrowth: number;
  width: number;
  columns: number;
}): StatItem[] {
  const addTrim = formatCurrency(result.addTrimValue, baseCurrency);
  const units = result.estimatedUnits == null ? null : `${formatNumber(result.estimatedUnits, 1)} units`;
  // The units ride beside the amount when the column has room for label,
  // amount and units (plus the cell inset and gaps); otherwise they take a
  // cell of their own rather than being cut off at the column edge.
  const unitsInline = units != null
    && Math.floor(width / Math.max(1, columns)) >= RESULT_LABEL_CHARS + displayWidth(addTrim) + displayWidth(units) + 6;
  return [
    { id: "full", label: "Full Kelly", value: formatPct(result.fullKellyFraction, 1) },
    { id: "fractional", label: "Fractional", value: formatPct(result.fractionalKellyFraction, 1) },
    {
      id: "clipped",
      label: "Clipped",
      value: formatPct(result.clippedFraction, 2),
      tone: result.clipReasons.length > 0 ? "positive" : undefined,
    },
    { id: "current", label: "Current %", value: formatPct(result.currentFraction, 1) },
    { id: "target", label: "Target val", value: formatCurrency(result.targetValue, baseCurrency) },
    {
      id: "addTrim",
      label: "Add / trim",
      value: addTrim,
      detail: unitsInline ? units ?? undefined : undefined,
      color: priceColor(result.addTrimValue),
    },
    ...(units != null && !unitsInline
      ? [{ id: "units", label: "Units", value: formatNumber(result.estimatedUnits!, 1) }]
      : []),
    {
      id: "risk",
      label: "Risk",
      value: formatCurrency(result.riskValue, baseCurrency),
      detail: formatPct(result.riskFraction, 2),
      tone: "negative",
    },
    { id: "worstLoss", label: "Worst loss", value: formatPct(result.downsideLossFraction, 1) },
    {
      id: "expReturn",
      label: "Exp return",
      value: formatSignedPct(result.expectedReturn),
      color: priceColor(result.expectedReturn),
    },
    { id: "fullGrowth", label: "Full growth", value: formatSignedPct(result.expectedLogGrowth) },
    { id: "growthNow", label: "Growth now", value: formatSignedPct(currentGrowth) },
    { id: "growthTarget", label: "Growth tgt", value: formatSignedPct(targetGrowth) },
  ];
}

export function KellyCurveSection({
  width,
  height,
  points,
  xAxisLabels,
  curveMaxFraction,
  markers,
  focused = false,
}: {
  width: number;
  height: number;
  points: ProjectedChartPoint[];
  xAxisLabels: string[];
  curveMaxFraction: number;
  markers: StaticChartXMarker[];
  focused?: boolean;
}) {
  // The curve takes the rest of the pane; the box absorbs any rounding so the
  // chart never pushes past the footer.
  return (
    <Box paddingX={1} flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
      <StaticChartSurface
        points={points}
        width={Math.max(10, width - 2)}
        height={height}
        mode="line"
        colors={resolveChartPalette(colors, "positive")}
        yAxisLabel="Expected log growth"
        yAxisColor={colors.textDim}
        formatYAxisValue={(value) => formatSignedPct(value)}
        xAxisLabels={xAxisLabels}
        xAxisColor={colors.textDim}
        formatXAxisCursorValue={(ratio) => formatPct(curveMaxFraction * ratio, 1)}
        xMarkers={markers}
        focused={focused}
      />
    </Box>
  );
}

interface SensitivityRow {
  /** Row position: clamped probabilities can repeat a label (99.0% twice). */
  id: string;
  label: string;
  cells: SensitivityGrid["cells"][number];
}

const ROW_AXIS_COLUMN = "row";
const FILL_COLUMN = "fill";

/**
 * The target size over a small grid of the two main inputs: rows vary the
 * first (win or estimated probability), columns the second (upside, price).
 */
export function KellySensitivitySection({
  width,
  height,
  focused,
  sensitivity,
}: {
  width: number;
  height: number;
  focused: boolean;
  sensitivity: SensitivityGrid;
}) {
  const columns = useMemo<DataTableColumn[]>(() => [
    { id: ROW_AXIS_COLUMN, label: sensitivity.rowLabel, width: 10, align: "left" },
    ...sensitivity.columns.map((column, index) => ({
      id: String(index),
      label: `${sensitivity.columnLabel} ${column}`,
      width: Math.max(10, sensitivity.columnLabel.length + column.length + 1),
      align: "right" as const,
    })),
    // A small matrix reads best packed beside its row axis; the empty column
    // takes the rest of the width so the header band still spans the pane.
    { id: FILL_COLUMN, label: "", width: 1, flexGrow: 1, align: "left" },
  ], [sensitivity.columnLabel, sensitivity.columns, sensitivity.rowLabel]);
  const rows = useMemo<SensitivityRow[]>(
    () => sensitivity.rows.map((label, index) => ({ id: String(index), label, cells: sensitivity.cells[index] ?? [] })),
    [sensitivity.cells, sensitivity.rows],
  );
  const renderCell = (row: SensitivityRow, column: DataTableColumn): DataTableCell => {
    if (column.id === ROW_AXIS_COLUMN) return { text: row.label, color: colors.textDim };
    if (column.id === FILL_COLUMN) return { text: "" };
    return { text: row.cells[Number(column.id)]?.text ?? "—" };
  };

  return (
    <DataTableView<SensitivityRow>
      columns={columns}
      items={rows}
      getItemKey={(row) => row.id}
      selection={{ kind: "none" }}
      focused={focused}
      keyboardNavigation={false}
      sortColumnId={null}
      sortDirection="asc"
      renderCell={renderCell}
      rootWidth={width}
      rootHeight={Math.max(2, height)}
      emptyStateTitle="No sensitivity grid"
    />
  );
}
