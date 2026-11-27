import { useMemo, type ReactNode } from "react";
import type { CreditBoardPoint, CreditIndexQuote } from "../../../api-client/credit-boards";
import { ChartTableHeader, CompositeChart, DELAYED_SEGMENT, MarketBoardStack, PaneStatusBody, type ChartTableChart, type DataTableColumn, type MarketBoardRow, type PaneFooterSegment } from "../../../components";
import { staticSeries } from "../../../components/chart/static/series";
import { colors } from "../../../theme/colors";
import { formatLevel } from "./model";

const PANELS = [{ id: "main" }];

export interface CreditHistoryTarget {
  id: string; label: string; points: readonly CreditBoardPoint[]; quote: CreditIndexQuote; formatAxisValue: ChartTableChart["formatAxisValue"]; remoteKind: string;
}

const historySeries = (t: Pick<CreditHistoryTarget, "id" | "label" | "points">) => [staticSeries(
  t.points.map((p) => ({ date: new Date(`${p.date}T00:00:00Z`), observedAt: new Date(`${p.date}T00:00:00Z`), value: p.level })),
  { id: t.id, label: `${t.label} 5Y`, color: colors.positive, calendarSpaced: true },
)];

function creditHistoryChart(target: CreditHistoryTarget): ChartTableChart {
  return {
    series: target.points.length >= 3 ? historySeries(target) : [],
    formatValue: (value: number) => formatLevel(target.quote, value),
    formatAxisValue: target.formatAxisValue,
    remoteKind: target.remoteKind,
    // A row without a history keeps the band, so the board does not jump under the cursor.
    empty: `No history for ${target.label}`,
  };
}

export function CreditHistoryChart({ target, width, height, focused }: { target: CreditHistoryTarget; width: number; height: number; focused: boolean }) {
  const series = useMemo(() => historySeries(target), [target]);
  return <CompositeChart series={series} panels={PANELS} width={width} height={height} focused={focused} showLegend={false}
    navigable={false} showTimeAxis formatAxisValue={target.formatAxisValue} remoteKind={target.remoteKind} />;
}

export function creditFooterInfo(sourceLine: PaneFooterSegment | null, hasPayload: boolean, stale: boolean | undefined, extra: readonly PaneFooterSegment[] = []): PaneFooterSegment[] {
  return [
    ...(sourceLine ? [sourceLine] : []),
    ...(hasPayload ? [DELAYED_SEGMENT] : []),
    ...(stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
    ...extra,
  ];
}

export function CreditBoardView<TRow extends MarketBoardRow>({
  rows,
  width,
  height,
  focused,
  loading,
  error,
  loadingLabel,
  subject,
  selectedId,
  namedId,
  onSelectedIdChange,
  openId,
  onOpenIdChange,
  labelHeader,
  labelWidth,
  valueLabel,
  valueWidth,
  changeLabel,
  extraColumns,
  historyTarget,
  renderDetail,
}: {
  rows: readonly TRow[];
  width: number;
  height: number;
  focused: boolean;
  loading: boolean;
  error: string | null;
  loadingLabel: string;
  subject: string;
  selectedId: string | null;
  namedId?: string | null;
  onSelectedIdChange: (id: string | null) => void;
  openId: string | null;
  onOpenIdChange: (id: string | null) => void;
  labelHeader: string;
  labelWidth: number;
  valueLabel: string;
  valueWidth: number;
  changeLabel?: string;
  extraColumns: readonly {
    column: DataTableColumn;
    sortValue: (row: TRow) => number | string | null;
    renderCell: (row: TRow) => { text: string; color?: string };
  }[];
  historyTarget: (row: TRow) => CreditHistoryTarget;
  renderDetail: (row: TRow, detailHeight: number) => ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <PaneStatusBody loading={loading} error={error} empty={!loading && !error}
        loadingLabel={loadingLabel} subject={subject} align="center" width={width} height={height} />
    );
  }
  const selected = rows.find((row) => row.id === selectedId)
    ?? (namedId ? rows.find((row) => row.id === namedId) : undefined)
    ?? rows[0];
  return (
    <MarketBoardStack rows={[...rows]} width={width} height={height} focused={focused}
      rootBefore={({ columns }) => <ChartTableHeader width={width} height={height} tableRows={rows.length}
        tableColumns={columns} chart={selected ? creditHistoryChart(historyTarget(selected)) : null} />}
      selectedId={selected?.id ?? null} onSelectedIdChange={onSelectedIdChange} openId={openId} onOpenIdChange={onOpenIdChange}
      labelHeader={labelHeader} labelWidth={labelWidth} valueLabel={valueLabel} valueWidth={valueWidth}
      changeLabel={changeLabel} signedChange extraColumns={[...extraColumns]}
      renderDetail={(row) => renderDetail(row, Math.max(5, height - 2))} />
  );
}
