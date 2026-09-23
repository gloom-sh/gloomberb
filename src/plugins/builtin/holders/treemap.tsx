import { useMemo } from "react";
import { MetricTreemapSurface, type MetricTreemapItem } from "../../../components/metric-treemap";
import { formatCompact } from "../../../utils/format";
import {
  formatHolderOwnershipLine,
  formatMaybePercent,
  formatMoneyCompact,
} from "./format";
import type { HolderRow } from "./types";

export function HoldersTreemap({ rows, width, height, selectedId, onSelect, onActivate, currency, marketCap, emptyStateTitle }: {
  rows: HolderRow[];
  width: number;
  height: number;
  selectedId: string | null;
  onSelect: (row: HolderRow) => void;
  onActivate?: (row: HolderRow) => void;
  currency: string;
  marketCap?: number;
  /** Loading, error, and no-ticker states the pane resolves for both views. */
  emptyStateTitle?: string;
}) {
  const items = useMemo<Array<MetricTreemapItem<HolderRow>>>(() => rows.map((row) => {
    const ownership = formatHolderOwnershipLine(row, marketCap);
    const change = row.changePercent != null ? formatMaybePercent(row.changePercent) : "No change";
    return {
      id: row.id,
      label: row.name,
      weight: row.value ?? row.shares ?? 0,
      colorValue: row.changePercent ?? null,
      primaryText: row.value != null
        ? formatMoneyCompact(row.value, currency)
        : formatCompact(row.shares),
      secondaryText: ownership ?? change,
      tertiaryText: ownership ? change : null,
      data: row,
    };
  }), [currency, marketCap, rows]);

  return (
    <MetricTreemapSurface
      items={items}
      width={width}
      height={height}
      selectedId={selectedId}
      onSelect={(item) => onSelect(item.data)}
      onActivate={onActivate ? (item) => onActivate(item.data) : undefined}
      emptyStateTitle={emptyStateTitle ?? "No chartable holder values"}
    />
  );
}
