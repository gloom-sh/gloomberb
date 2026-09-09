import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DataTableView,
  EmptyState,
  Spinner,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment
} from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes } from "../../../ui";
import type { PluginModule } from "../plugin-module";
import { useAutoRefresh } from "../shared/auto-refresh";
import { getCachedCreditConditions, loadCreditConditions } from "./client";
import { creditConditionsHeadless } from "./headless";
import {
  CREDIT_SERIES,
  type CreditConditionRow,
  type CreditSeriesId,
} from "./model";

export { creditConditionsHeadless } from "./headless";

const EMPTY_ROWS: CreditConditionRow[] = [];

type SortId = "label" | "oas" | "change";
interface Column extends DataTableColumn { id: SortId }

const COLUMNS: readonly Column[] = [
  { id: "label", label: "INDEX", width: 12, align: "left" },
  { id: "oas", label: "OAS", width: 10, align: "right" },
  { id: "change", label: "1D", width: 9, align: "right" },
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
    else comparison = (left.dailyChangeBp ?? -Infinity) - (right.dailyChangeBp ?? -Infinity);
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
  const resource = useAsyncResource(loadCreditConditions, { initialData: getCachedCreditConditions });
  const { loading, load: refresh, reload } = resource;
  const stale = resource.data?.stale ?? false;
  const error = resource.error ?? resource.data?.errors[0] ?? null;
  const lastUpdated = stale ? null : resource.updatedAt;
  const rows = resource.data?.rows ?? EMPTY_ROWS;
  const [selectedId, setSelectedId] = useState<CreditSeriesId | null>(rows[0]?.seriesId ?? null);
  const [sort, setSort] = useState<{ id: SortId; descending: boolean }>({ id: "label", descending: false });
  useEffect(() => {
    setSelectedId((id) => id && rows.some((row) => row.seriesId === id) ? id : rows[0]?.seriesId ?? null);
  }, [rows]);
  // The shared FRED cache decides whether a tick actually hits the network, so
  // the pane can follow the global cadence without refetching daily data.
  useAutoRefresh(lastUpdated, refresh);

  const sorted = useMemo(() => sortRows(rows, sort.id, sort.descending), [rows, sort]);
  const selectedRow = rows.find((row) => row.seriesId === selectedId) ?? rows[0] ?? null;
  const columns = useMemo<Column[]>(() => {
    const labelWidth = Math.max(12, width - 23);
    return COLUMNS.map((column) => column.id === "label" ? { ...column, width: labelWidth } : { ...column });
  }, [width]);
  const renderRowCell = useCallback((
    row: CreditConditionRow,
    column: Column,
    index: number,
    state: { selected: boolean },
  ): DataTableCell => ({
    ...renderCell(row, column, index, state),
    onMouseDown: () => setSelectedId(row.seriesId),
  }), []);
  useShortcut((event) => {
    if (!focused || event.name !== "r" || loading) return;
    reload();
    event.preventDefault?.();
    event.stopPropagation?.();
  });
  const partial = rows.length > 0 && rows.length < CREDIT_SERIES.length;
  const asOf = rows.reduce<string | null>((latest, row) => !latest || row.date > latest ? row.date : latest, null);
  const footerInfo = useMemo<PaneFooterSegment[]>(() => [
    ...(asOf ? [{ id: "as-of", parts: [{ text: `as of ${asOf}`, tone: "muted" as const }] }] : []),
    ...(rows.length > 0 ? [{ id: "delayed", parts: [{ text: "delayed", tone: "muted" as const }] }] : []),
    ...(partial ? [{ id: "partial", parts: [{ text: `PARTIAL ${rows.length}/${CREDIT_SERIES.length}`, tone: "warning" as const, bold: true }] }] : []),
    ...(stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
    ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
    ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
  ], [asOf, error, loading, partial, rows.length, stale]);
  usePaneFooter(paneId, () => ({ info: footerInfo }), [footerInfo, paneId]);

  if (rows.length === 0 && loading) {
    return (
      <Box width={width} height={height} justifyContent="center" alignItems="center">
        <Spinner label="Loading credit spreads..." />
      </Box>
    );
  }
  if (rows.length === 0) {
    return (
      <Box width={width} height={height} padding={1} flexDirection="column" gap={1}>
        <EmptyState title="Credit spreads unavailable." message={error ?? undefined} />
      </Box>
    );
  }

  const metadata = (
    <Box height={2} flexDirection="column" paddingX={1}>
      <Text fg={colors.textMuted}>FRED · option-adjusted spread · daily close</Text>
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
      columns={columns}
      items={sorted}
      sortColumnId={sort.id}
      sortDirection={sort.descending ? "desc" : "asc"}
      onHeaderClick={(id) => setSort((current) => ({
        id: id as SortId,
        descending: current.id === id ? !current.descending : id !== "label",
      }))}
      getItemKey={(row) => row.seriesId}
      renderCell={renderRowCell}
      emptyStateTitle={loading ? "Loading credit spreads..." : error ?? "No credit spread data."}
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
    headless: creditConditionsHeadless,
  }],
};
