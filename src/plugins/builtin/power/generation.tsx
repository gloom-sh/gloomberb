import { useMemo } from "react";
import type { PowerProject } from "../../../api-client/power";
import { ChartTableHeader, DataTableView, staticSeries, useChartTableSelection, type DataTableColumn } from "../../../components";
import { usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { powerNumber } from "./model";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const COLUMNS: DataTableColumn[] = [{ id: "month", label: "Month", width: 18, align: "left", flexGrow: 1 }, { id: "mwh", label: "Generation MWh", width: 20, align: "right" }, { id: "change", label: "Change MWh", width: 20, align: "right" }];
export function generationRows(project: PowerProject) {
  if (!/^\d{4}$/.test(project.period ?? "")) return [];
  let previous: number | null = null;
  return MONTHS.map((month, index) => {
    const raw = project.metrics[`generation${month}Mwh`];
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const change = value === null || previous === null ? null : value - previous;
    previous = value;
    return { id: `${project.period}-${String(index + 1).padStart(2, "0")}`, date: new Date(Date.UTC(Number(project.period), index, 1)), month, value, change };
  });
}
const rowId = (row: ReturnType<typeof generationRows>[number]) => row.id;
const rowDate = (row: ReturnType<typeof generationRows>[number]) => row.date;
export function PowerGeneration({ project, width, height, focused }: { project: PowerProject; width: number; height: number; focused: boolean }) {
  const colors = useThemeColors();
  const rows = useMemo(() => generationRows(project), [project]);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("power:generation-month", null);
  const selected = rows.find((row) => row.id === selectedId) ?? rows.at(-1);
  const selection = useChartTableSelection({ rows, getId: rowId, getDate: rowDate, selectedId: selected?.id ?? null, onSelect: setSelectedId, focused });
  const series = useMemo(() => [{ ...staticSeries(rows.map((row) => ({ date: row.date, observedAt: new Date(project.observedAt), value: row.value })),
    { id: "power-generation", label: `${project.period} net generation`, color: colors.warning, negativeColor: colors.negative, style: "columns", calendarSpaced: true }), unit: "MWh", unitGroup: "power-energy" }], [rows, project.observedAt, project.period, colors.warning, colors.negative]);
  return <DataTableView columns={COLUMNS} items={rows} getItemKey={rowId} rootWidth={width} rootHeight={height} focused={focused}
    selection={{ kind: "id", getId: rowId, selectedId: selected?.id ?? null, onChange: setSelectedId }}
    emptyStateTitle="No monthly generation reported." sortColumnId={null} sortDirection="asc" renderCell={(row, column) => column.id === "month" ? { text: row.month, value: row.id }
      : { text: powerNumber(column.id === "mwh" ? row.value : row.change), value: (column.id === "mwh" ? row.value : row.change) ?? undefined }}
    rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={COLUMNS}
      figures={[{ id: "annual", label: `${project.period} MWh`, value: powerNumber(typeof project.metrics.generationMwh === "number" ? project.metrics.generationMwh : null) }]}
      chart={{ series, ...selection, formatValue: (value) => `${powerNumber(value)} MWh`, remoteKind: "power-monthly-generation" }} />} />;
}
