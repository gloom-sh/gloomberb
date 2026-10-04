import { useCallback, useMemo } from "react";
import type { GpuBoardRow, GpuEvent } from "../../../api-client/gpu";
import {
  Badge, buildSectionedRows, DataTableView, EMPTY_TABLE_CELL, isSectionedItemRow, PaneStatusBody, renderSectionedRowHeader,
  usePaneNoticeFooter, usePaneStatusFooter, type DataTableCell, type DataTableColumn, type SectionedRow,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, TextAttributes } from "../../../ui";
import { GpuModelQuery, GpuVariantChips } from "./board";
import { loadGpuEvents } from "./client";
import { gpuBasisLabel, gpuChange, gpuEventSections, gpuPrice, gpuShortSource, gpuVariant } from "./model";

type ChangeRow = SectionedRow<GpuEvent>;
const rowKey = (row: ChangeRow) => row.key;

function changeColumns(width: number, allModels: boolean): DataTableColumn[] {
  const wide = width >= 140, medium = width >= 100;
  return [
    ...(allModels ? [{ id: "gpu", label: "GPU", width: 8, align: "left" as const }] : []),
    { id: "source", label: "Provider", width: wide ? 24 : 16, flexGrow: medium ? 0 : 1, align: "left" },
    ...(medium ? [{ id: "variant", label: "Variant", width: 13, align: "left" as const }] : []),
    { id: "basis", label: "Basis", width: wide ? 22 : 5, align: "left" },
    { id: "move", label: medium ? "$/GPU-hr" : "$/h", width: medium ? 15 : 13, align: "right" },
    { id: "change", label: "Change", width: 9, align: "right" },
    { id: "kind", label: "Event", width: wide ? 18 : medium ? 15 : 10, flexGrow: medium ? 1 : 0, align: "left" },
  ];
}

/** Dated price moves, newest day first: provider, old to new, and the move as a chip coloured by its sign. */
export function GpuChanges({ board, model, setModel, reloadBoard, width, height, focused }: {
  board: GpuBoardRow[]; model: string; setModel: (value: string) => void; reloadBoard: () => void; width: number; height: number; focused: boolean;
}) {
  const colors = useThemeColors();
  const loader = useCallback((force: boolean) => loadGpuEvents(model || undefined, force), [model]);
  const resource = useAsyncResource(loader);
  const [selected, setSelected] = usePluginPaneState<string | null>("eventSelected", null);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => { reloadBoard(); void resource.reload(); }, { focused });
  usePaneStatusFooter({ registrationId: "gpu:changes", loading: resource.loading, error: resource.error, stale: resource.data?.stale });
  usePaneNoticeFooter({ registrationId: "gpu:change-notices", focused, notices: resource.data?.refreshError ? [resource.data.refreshError] : [] });
  const events = resource.data?.payload.events;
  const items = useMemo(() => buildSectionedRows(gpuEventSections(events ?? []), (event) => event.id), [events]);
  const firstId = items.find(isSectionedItemRow)?.key ?? null;
  const wide = width >= 140, medium = width >= 100;
  const columns = changeColumns(width, !model);

  const renderCell = (row: ChangeRow, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    if (!isSectionedItemRow(row)) return EMPTY_TABLE_CELL;
    const event = row.item;
    const membership = event.kind === "membership";
    switch (column.id) {
      case "gpu": return { text: event.gpuModel, color: colors.textBright };
      case "source": return { text: gpuShortSource(event), color: colors.text };
      case "variant": return { text: gpuVariant(event).join(" "), content: <GpuVariantChips row={event} width={column.width} selected={state.selected} /> };
      case "basis": return { text: gpuBasisLabel(event.basis, !wide), color: colors.textDim };
      case "move": return { text: `${gpuPrice(event.oldPrice)} → ${gpuPrice(event.newPrice)}`, value: event.newPrice,
        content: <Box flexDirection="row" justifyContent="flex-end" width={column.width} height={1} overflow="hidden">
          <Text fg={state.selected ? colors.selectedText : colors.textDim}>{`${gpuPrice(event.oldPrice)} → `}</Text>
          <Text fg={state.selected ? colors.selectedText : colors.textBright} attributes={TextAttributes.BOLD}>{gpuPrice(event.newPrice)}</Text>
        </Box> };
      case "change": {
        const text = gpuChange(event.changePct);
        const tone = event.changePct > 0 ? "positive" : event.changePct < 0 ? "negative" : "neutral";
        return { text, value: event.changePct, content: <Box flexDirection="row" justifyContent="flex-end" width={column.width} height={1}>
          <Badge label={text} tone={tone} />
        </Box> };
      }
      case "kind": {
        const at = event.effectiveAt ?? event.observedAt;
        const text = membership ? `Basket ${event.oldMembers?.length ?? 0} → ${event.newMembers?.length ?? 0}`
          : event.origin === "published" ? medium ? "Published rate" : "Published" : `Observed ${event.observedAt.slice(11, 16)}`;
        return { text, value: at, color: colors.textDim };
      }
      default: return EMPTY_TABLE_CELL;
    }
  };

  return <PaneStatusBody loading={resource.loading && !resource.data} error={!resource.data ? resource.error : null} subject="GPU price changes">
    <DataTableView<ChangeRow> columns={columns} items={items} rootWidth={width} rootHeight={height} focused={focused}
      rootBefore={<GpuModelQuery rows={board} model={model} setModel={setModel} width={width} />}
      selection={{ kind: "id", selectedId: selected && items.some((item) => item.key === selected) ? selected : firstId, getId: rowKey,
        onChange: (id) => setSelected(String(id)) }}
      isNavigable={isSectionedItemRow} renderSectionHeader={renderSectionedRowHeader}
      getItemKey={rowKey} onActivate={(row) => setSelected(row.key)} sortColumnId={null} sortDirection="desc"
      selectedTextOverridesCellColor renderCell={renderCell} emptyStateTitle="No price changes recorded yet." />
  </PaneStatusBody>;
}
