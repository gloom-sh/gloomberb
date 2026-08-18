import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, TextAttributes } from "../../../ui";
import {
  DataTableView,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type PaneFooterSegment,
} from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import { colors } from "../../../theme/colors";
import type { PluginModule } from "../plugin-module";
import { getCachedCreditConditions, loadCreditConditions } from "./client";
import {
  CREDIT_SERIES,
  type CreditConditionRow,
  type CreditSeriesId,
} from "./model";

type SortId = "label" | "oas" | "change" | "date";
interface Column extends DataTableColumn { id: SortId }

const COLUMNS: readonly Column[] = [
  { id: "label", label: "INDEX", width: 12, align: "left" },
  { id: "oas", label: "OAS", width: 10, align: "right" },
  { id: "change", label: "1D", width: 9, align: "right" },
  { id: "date", label: "AS OF", width: 12, align: "right" },
];

function formatBp(value: number | null, signed = false): string {
  if (value == null) return "--";
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}bp`;
}

function sortRows(rows: CreditConditionRow[], id: SortId, descending: boolean): CreditConditionRow[] {
  return [...rows].sort((left, right) => {
    let comparison = 0;
    if (id === "label") comparison = left.label.localeCompare(right.label);
    else if (id === "oas") comparison = left.oasBp - right.oasBp;
    else if (id === "change") comparison = (left.dailyChangeBp ?? -Infinity) - (right.dailyChangeBp ?? -Infinity);
    else comparison = left.date.localeCompare(right.date);
    return descending ? -comparison : comparison;
  });
}

function renderCell(
  row: CreditConditionRow,
  column: Column,
  _index: number,
  state: { selected: boolean },
): DataTableCell {
  const selected = state.selected ? colors.selectedText : undefined;
  if (column.id === "label") return { text: row.label, color: selected ?? colors.text, attributes: TextAttributes.BOLD };
  if (column.id === "oas") return { text: formatBp(row.oasBp), color: selected ?? colors.textBright };
  if (column.id === "date") return { text: row.date, color: selected ?? colors.textDim };
  return {
    text: formatBp(row.dailyChangeBp, true),
    color: selected ?? (row.dailyChangeBp == null
      ? colors.textDim
      : row.dailyChangeBp > 0
        ? colors.negative
        : row.dailyChangeBp < 0
          ? colors.positive
          : colors.textDim),
  };
}

export function CreditConditionsPane({ paneId, focused, width, height }: PaneProps) {
  const [initial] = useState(getCachedCreditConditions);
  const [rows, setRows] = useState(initial?.rows ?? []);
  const [selectedId, setSelectedId] = useState<CreditSeriesId | null>(initial?.rows[0]?.seriesId ?? null);
  const [sort, setSort] = useState<{ id: SortId; descending: boolean }>({ id: "label", descending: false });
  const [loading, setLoading] = useState(!initial);
  const [stale, setStale] = useState(initial?.stale ?? false);
  const [error, setError] = useState<string | null>(initial?.errors[0] ?? null);
  const generation = useRef(0);

  const load = useCallback(async (force = false) => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loadCreditConditions(force);
      if (generation.current !== current) return;
      setRows(result.rows);
      setSelectedId((id) => id && result.rows.some((row) => row.seriesId === id) ? id : result.rows[0]?.seriesId ?? null);
      setStale(result.stale);
      setError(result.errors[0] ?? null);
    } catch (loadError) {
      if (generation.current !== current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(false); }, [load]);
  const refresh = useCallback(() => { void load(true); }, [load]);

  const sorted = useMemo(() => sortRows(rows, sort.id, sort.descending), [rows, sort]);
  const selectedRow = rows.find((row) => row.seriesId === selectedId) ?? rows[0] ?? null;
  const columns = useMemo<Column[]>(() => {
    const labelWidth = Math.max(12, width - 35);
    return COLUMNS.map((column) => column.id === "label" ? { ...column, width: labelWidth } : { ...column });
  }, [width]);
  const partial = rows.length > 0 && rows.length < CREDIT_SERIES.length;
  const footerInfo = useMemo<PaneFooterSegment[]>(() => [
    ...(partial ? [{ id: "partial", parts: [{ text: "PARTIAL", tone: "warning" as const, bold: true }] }] : []),
    ...(stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
    ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
    ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
  ], [error, loading, partial, stale]);
  usePaneFooter(paneId, () => ({
    info: footerInfo,
    hints: [{ id: "refresh", key: "r", label: "efresh", onPress: refresh, disabled: loading }],
  }), [footerInfo, loading, paneId, refresh]);

  const handleKey = useCallback((event: DataTableKeyEvent) => {
    if (event.name !== "r") return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    refresh();
    return true;
  }, [refresh]);

  if (rows.length === 0 && loading) {
    return <Box width={width} height={height} justifyContent="center" alignItems="center"><Text fg={colors.textMuted}>Loading credit spreads...</Text></Box>;
  }
  if (rows.length === 0) {
    return <Box width={width} height={height} padding={1}><Text fg={colors.negative}>{error ?? "Credit spread data unavailable"}</Text></Box>;
  }

  const metadata = (
    <Box height={2} flexDirection="column" paddingX={1}>
      <Text fg={colors.textMuted}>FRED · option-adjusted spread · daily close · delayed</Text>
      <Text fg={colors.textDim}>{selectedRow?.title ?? ""}</Text>
    </Box>
  );

  return (
    <DataTableView<CreditConditionRow, Column>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      rootBefore={metadata}
      selection={{
        kind: "id",
        selectedId,
        getId: (row) => row.seriesId,
        onChange: (id) => setSelectedId(id as CreditSeriesId),
      }}
      onRootKeyDown={handleKey}
      columns={columns}
      items={sorted}
      sortColumnId={sort.id}
      sortDirection={sort.descending ? "desc" : "asc"}
      onHeaderClick={(id) => setSort((current) => ({
        id: id as SortId,
        descending: current.id === id ? !current.descending : id !== "label",
      }))}
      getItemKey={(row) => row.seriesId}
      renderCell={renderCell}
      emptyStateTitle="No credit spread data."
      emptyStateHint="Press r to retry."
    />
  );
}

export const creditConditionsModule: PluginModule = {
  panes: [{
    id: "credit-conditions",
    name: "Credit Spreads",
    icon: "C",
    component: CreditConditionsPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 72, height: 18 },
  }],
  paneTemplates: [{
    id: "credit-conditions-pane",
    paneId: "credit-conditions",
    label: "Credit Spreads",
    description: "ICE BofA US corporate option-adjusted spreads from FRED.",
    keywords: ["credit", "spread", "oas", "corporate", "high yield", "investment grade", "macro"],
    shortcut: { prefix: "CRD" },
  }],
};
