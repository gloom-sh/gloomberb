import { useCallback, useMemo } from "react";
import type { GpuBoardRow } from "../../../api-client/gpu";
import {
  Badge, buildSectionedRows, ChartTableHeader, DataTableView, EMPTY_TABLE_CELL, isSectionedItemRow, QueryBar,
  renderSectionedRowHeader, type DataTableCell, type DataTableColumn, type SectionedRow,
} from "../../../components";
import { PriceSparkline } from "../../../components/price-sparkline/view";
import { useAsyncResource } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PricePoint } from "../../../types/financials";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { loadGpuHistory } from "./client";
import { GpuPriceLadder } from "./ladder";
import {
  gpuAvailability, gpuBoardSections, gpuChange, gpuChangeColor, gpuChangeWindows, gpuHeadline, gpuPrice, gpuPriceLadder, gpuShortSource, gpuSparklineSeries, gpuTime, gpuVariant,
  type GpuChangeKey,
} from "./model";

type BoardRow = SectionedRow<GpuBoardRow>;
const rowKey = (row: BoardRow) => row.key;
const EMPTY_HISTORY = new Map<string, PricePoint[]>();
const CHANGE_LABELS: Record<GpuChangeKey, string> = { change1d: "1D", change7d: "7D", change30d: "30D" };
/** A line needs three observations; two are a step, not a trend. */
const MIN_TREND_POINTS = 3;

export function GpuModelQuery({ rows, model, setModel, width, allowAll = true }: {
  rows: readonly GpuBoardRow[]; model: string; setModel: (value: string) => void; width: number; allowAll?: boolean;
}) {
  const models = useMemo(() => [...new Set(rows.map((row) => row.gpuModel))].sort(), [rows]);
  return <QueryBar width={width} filters={[{ id: "gpu", label: "GPU", value: model, ...(allowAll ? { defaultValue: "" } : {}),
    options: [...(allowAll ? [{ value: "", label: "All GPUs" }] : []), ...models.map((value) => ({ value, label: value }))], onChange: setModel }]} />;
}

/**
 * Variant chips, the same in every GPU table: form factor and memory in two
 * aligned slots. The terminal prints them as quiet text, where a block of
 * colour on every row would outweigh the price.
 */
export function GpuVariantChips({ row, width, selected = false }: { row: Pick<GpuBoardRow, "formFactor" | "memoryGb">; width: number; selected?: boolean }) {
  const colors = useThemeColors();
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const [form, memory] = [row.formFactor ?? "", row.memoryGb ? `${row.memoryGb}GB` : ""];
  if (!desktop) return <Text fg={selected ? colors.selectedText : colors.textDim}>{`${form.padEnd(5)} ${memory}`.trimEnd()}</Text>;
  return <Box flexDirection="row" gap={1} width={width} height={1} overflow="hidden">
    <Box width={6} flexShrink={0}>{form ? <Badge label={form} /> : null}</Box>
    {memory ? <Badge label={memory} /> : null}
  </Box>;
}

/** Sparklines for the series `gpuSparklineSeries` picks, one bounded request each. */
function useHeadlineHistory(rows: readonly GpuBoardRow[], model: string): Map<string, PricePoint[]> {
  const ids = useMemo(() => gpuSparklineSeries(rows, model).join("\n"), [rows, model]);
  const loader = useCallback(async (force: boolean) => new Map(await Promise.all(ids.split("\n").map(async (id) => {
    const points = (await loadGpuHistory(id, force)).payload.points
      .filter((point) => `${point.source}:${point.skuKey}` === id)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
      .map((point) => ({ date: new Date(point.observedAt), close: point.pricePerGpuHr }));
    return [id, points] as const;
  }))), [ids]);
  const resource = useAsyncResource(ids ? loader : null, { keepPreviousData: true });
  return resource.data ?? EMPTY_HISTORY;
}

function boardColumns(width: number, options: { windows: GpuChangeKey[]; trend: boolean; range: boolean; availability: boolean }): DataTableColumn[] {
  const wide = width >= 140, medium = width >= 100;
  const changes: DataTableColumn[] = options.windows.length
    ? options.windows.map((key) => ({ id: key, label: CHANGE_LABELS[key], width: medium ? 7 : 6, align: "right" }))
    : [{ id: "new", label: "Change", width: medium ? 7 : 6, align: "right" }];
  return [
    { id: "source", label: "Provider", width: wide ? 32 : medium ? 24 : 16, flexGrow: medium ? 0 : 1, align: "left" },
    { id: "variant", label: "Variant", width: medium ? 13 : 12, align: "left" },
    { id: "price", label: "$/GPU-hr", width: medium ? 9 : 7, align: "right" },
    ...(options.range && medium ? [{ id: "range", label: "Range", width: 12, align: "right" as const }] : []),
    ...changes,
    ...(options.trend && medium ? [{ id: "trend", label: "Trend", width: wide ? 14 : 10, align: "left" as const }] : []),
    // On a wide pane the spare width opens before the time, not between the name and its price.
    ...(options.availability ? [{ id: "availability", label: medium ? "Availability" : "Avail", width: medium ? 14 : 9, flexGrow: medium ? 1 : 0, align: "left" as const }] : []),
    ...(medium ? [{ id: "asof", label: "Updated (UTC)", width: 13, flexGrow: options.availability ? 0 : 1, align: "right" as const }] : []),
  ];
}

export function GpuBoard({ rows, asOf, model, setModel, selectedId, select, width, height, focused }: {
  rows: GpuBoardRow[]; asOf: string | null; model: string; setModel: (value: string) => void; selectedId: string; select: (row: GpuBoardRow, open?: boolean) => void;
  width: number; height: number; focused: boolean;
}) {
  const colors = useThemeColors();
  const sections = useMemo(() => gpuBoardSections(rows, model), [rows, model]);
  const items = useMemo(() => buildSectionedRows(sections.map((section) => ({ label: section.label, items: section.rows })), (row) => row.id), [sections]);
  const visible = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const windows = useMemo(() => gpuChangeWindows(visible), [visible]);
  const history = useHeadlineHistory(rows, model);
  const trend = [...history.values()].some((points) => points.length >= MIN_TREND_POINTS);
  const ladder = useMemo(() => model ? gpuPriceLadder(rows, model) : [], [rows, model]);
  const selected = visible.find((row) => row.id === selectedId) ?? visible[0] ?? null;
  const medium = width >= 100;
  const asOfDay = asOf?.slice(0, 10) ?? null;
  const columns = boardColumns(width, { windows, trend, range: visible.some((row) => row.stats), availability: visible.some((row) => row.availability) });

  const renderCell = (item: BoardRow, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    if (!isSectionedItemRow(item)) return EMPTY_TABLE_CELL;
    const row = item.item;
    const headline = gpuHeadline(row);
    const ink = state.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "source": {
        const name = gpuShortSource(row);
        const unit = row.providerClass === "aggregate" ? "provider" : "offer";
        const sample = headline && row.stats && medium ? `${row.stats.n} ${unit}${row.stats.n === 1 ? "" : "s"}` : "";
        return { text: name, content: <Box flexDirection="row" height={1} overflow="hidden">
          <Text fg={ink ?? (headline ? colors.textBright : colors.text)} attributes={headline ? TextAttributes.BOLD : 0}>{name}</Text>
          {sample ? <Text fg={colors.textDim}>{`  ${sample}`}</Text> : null}
        </Box> };
      }
      case "variant": return { text: gpuVariant(row).join(" "), content: <GpuVariantChips row={row} width={column.width} selected={state.selected} /> };
      case "price": return { text: gpuPrice(row.pricePerGpuHr), value: row.pricePerGpuHr, color: headline ? colors.textBright : colors.text,
        attributes: headline ? TextAttributes.BOLD : 0 };
      case "range": {
        const stats = row.stats;
        if (!stats) return { text: "" };
        const quartiles = stats.p25 !== undefined && stats.p75 !== undefined;
        if (!quartiles && stats.min === stats.max) return { text: "" };
        return { text: quartiles ? `${gpuPrice(stats.p25)}–${gpuPrice(stats.p75)}` : `${gpuPrice(stats.min)}–${gpuPrice(stats.max)}`, color: colors.textDim };
      }
      case "new": return { text: "new", value: null, color: colors.textMuted };
      case "change1d": case "change7d": case "change30d": {
        const value = row[column.id];
        return value == null ? { text: "", value: null } : { text: gpuChange(value), value, color: gpuChangeColor(value, colors) };
      }
      case "trend": {
        const points = history.get(row.id);
        return points && points.length >= MIN_TREND_POINTS
          ? { text: "", content: <PriceSparkline priceHistory={points} width={column.width} period="1M" /> }
          : { text: "" };
      }
      case "availability": {
        const availability = gpuAvailability(row.availability);
        if (!availability) return { text: "" };
        const tone = availability.tone === "positive" ? colors.positive : availability.tone === "warning" ? colors.warning : colors.textMuted;
        return { text: availability.label, content: <Box flexDirection="row" height={1} overflow="hidden">
          <Text fg={tone}>●</Text>
          {medium ? <Text fg={ink ?? (availability.tone === "muted" ? colors.textDim : colors.text)}>{` ${availability.label}`}</Text> : null}
        </Box> };
      }
      // The board's own day goes without saying; an older observation names its day.
      case "asof": return { text: row.stale ? "stale" : asOfDay && row.observedAt.startsWith(asOfDay) ? row.observedAt.slice(11, 16) : gpuTime(row.observedAt, true), value: row.observedAt,
        color: row.stale ? colors.warning : colors.textDim, keepColorWhenSelected: row.stale };
      default: return EMPTY_TABLE_CELL;
    }
  };

  const query = <GpuModelQuery rows={rows} model={model} setModel={setModel} width={width} />;
  return <DataTableView<BoardRow> columns={columns} items={items} rootWidth={width} rootHeight={height} focused={focused}
    rootBefore={ladder.length ? <ChartTableHeader width={width} height={height} tableRows={items.length} tableColumns={columns} query={query}
      chart={{ maxRows: ladder.length + 1, minRows: Math.min(3, ladder.length + 1), strip: null,
        render: (size) => <GpuPriceLadder rows={ladder} width={size.width} height={size.height}
          selected={selected && selected.gpuModel === model && selected.providerClass !== "aggregate" ? { basis: selected.basis, price: selected.pricePerGpuHr } : null} /> }} />
      : query}
    selection={{ kind: "id", selectedId: selected?.id ?? null, getId: rowKey,
      onChange: (_id, row) => { if (row && isSectionedItemRow(row)) select(row.item); } }}
    isNavigable={isSectionedItemRow} renderSectionHeader={renderSectionedRowHeader}
    getItemKey={rowKey} onActivate={(row) => { if (isSectionedItemRow(row)) select(row.item, true); }} sortColumnId={null} sortDirection="asc"
    selectedTextOverridesCellColor renderCell={renderCell} emptyStateTitle="No GPU rental prices match." />;
}
