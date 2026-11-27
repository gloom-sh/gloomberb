import { useMemo } from "react";
import type { CreditBoardPoint, CreditIndexQuote } from "../../../api-client/credit-boards";
import { CompositeChart, DELAYED_SEGMENT, type ChartTableChart, type PaneFooterSegment } from "../../../components";
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

export function creditHistoryChart(target: CreditHistoryTarget): ChartTableChart {
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
