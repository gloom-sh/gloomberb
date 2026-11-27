import { MISSING_VALUE } from "../../../utils/format";
import { useMemo } from "react";
import type { StatItem } from "../../../components";
import { usePaneResource } from "../shared/pane-resource";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { signedMoveColor, StatChartDetail } from "../../../components/market-board";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { usePluginPaneState } from "../../runtime";
import { FIXED_INCOME_PANE_ID } from "../fixed-income/model";
import { useCommandValue } from "../shared/command-tab";
import { reportFooterSegment } from "../shared/source-footer";
import { CreditBoardView, CreditHistoryChart, creditFooterInfo, type CreditHistoryTarget } from "./board-shared";
import { getCachedCdxBoard, loadCdxBoard } from "./client";
import { cdxHeadless } from "./headless";
import {
  axisFormatter,
  cdxRows,
  findIndex,
  formatContract,
  formatLevel,
  formatMove,
  formatSpreadRank,
  partialDayText,
  SETTLEMENT_TEXT,
  type CdxRow,
} from "./model";

const EMPTY_ROWS: CdxRow[] = [];
const historyTarget = (row: CdxRow): CreditHistoryTarget => ({
  id: row.id, label: row.label, points: row.index.points, quote: row.index.quote,
  formatAxisValue: axisFormatter(row.index.quote), remoteKind: "cdx-history",
});

function IndexDetail({ row, width, height, focused }: { row: CdxRow; width: number; height: number; focused: boolean }) {
  const { index, year, day, rank } = row;
  // While today trades the moves run to the last complete day, which the 1D says.
  const through = day.partial && day.changeDate ? `to ${day.changeDate}` : undefined;
  // The rank sits beside what it ranks: HY and EM's spread equivalent, not their price.
  const rankOnSpreadEq = rank.basis === "spread-eq";
  const spreadDetail = [...(rankOnSpreadEq ? [formatSpreadRank(rank)] : []),
    ...(index.recovery != null ? [`${Math.round(index.recovery * 100)}% recovery`] : [])].join(" · ");
  const items: StatItem[] = [
    { id: "level", label: index.quote === "spread" ? "5Y spread" : "5Y price", value: formatLevel(index.quote, index.level),
      detail: [...(rankOnSpreadEq ? [] : [formatSpreadRank(rank)]), index.date ?? MISSING_VALUE, ...(index.kind === "settlement" ? [SETTLEMENT_TEXT] : [])].join(" · ") },
    ...(index.quote === "price" && index.spreadBp !== undefined ? [{ id: "spread", label: "Spread eq", value: formatLevel("spread", index.spreadBp ?? null),
      ...(spreadDetail ? { detail: spreadDetail } : {}) }] : []),
    { id: "1d", label: "1D", value: formatMove(index.quote, day.change1D), ...(through ? { detail: through } : {}) },
    { id: "1w", label: "1W", value: formatMove(index.quote, day.change1W) },
    { id: "1m", label: "1M", value: formatMove(index.quote, day.change1M) },
    { id: "range", label: "1Y range", value: `${formatLevel(index.quote, year.low)} to ${formatLevel(index.quote, year.high)}` },
    { id: "contract", label: "Contract", value: formatContract(index.maturity), detail: `${index.couponBp}bp coupon` },
    { id: "prints", label: "Prints", value: index.prints == null ? MISSING_VALUE : String(index.prints),
      // The value is the count already: the detail says only that the day is still trading, and its last print.
      ...(day.partial ? { detail: partialDayText(null, day.lastPrintAt) } : {}) },
  ];
  const target = useMemo(() => historyTarget(row), [row]);
  return (
    <StatChartDetail items={items} width={width} height={height} empty={index.points.length < 3}
      emptySubject="index history" emptyTitle="No history available."
      renderChart={(chartHeight) => <CreditHistoryChart target={target} width={width} height={chartHeight} focused={focused} />} />
  );
}

export function CdxPane({ focused, width, height }: PaneProps) {
  const theme = useThemeColors();
  const resource = usePaneResource(loadCdxBoard, { focused, initialData: getCachedCdxBoard, refreshKey: { skipWhileLoading: true } });
  const { loading } = resource;
  const payload = resource.data?.payload ?? null;
  const rows = useMemo(() => payload ? cdxRows(payload.indexes, payload.asOf) : EMPTY_ROWS, [payload]);
  // `CDX HY` opens on that index, named as `fn CDX HY` names it; a later `CDX IG` replaces it.
  const [selectedId, setSelectedId] = useCommandValue<string | null>(
    FIXED_INCOME_PANE_ID,
    "cdx:selected",
    (params) => params.view === "index" && params.index ? params.index : null,
    null,
  );
  const [openId, setOpenId] = usePluginPaneState<string | null>("cdx:open", null);

  // Its source and the newest day the rows carry, not when the response was put together, as `fn CDX` ends.
  // The clock says the prints are delayed, so the line does not again.
  const sourceLine = useMemo(() => payload
    ? reportFooterSegment(cdxHeadless, { sections: [{ title: "", columns: [], rows: payload.indexes.map((index) => ({ date: index.date })) }] }, { feed: false })
    : null, [payload]);
  // PCTL 1Y ranks spreads; the rows quoted in price (HY, EM) rank their spread equivalent, which a picture keeps.
  const spreadEqRanked = useMemo(() => rows.filter((row) => row.rank.basis === "spread-eq")
    .map((row) => row.index.name.replace(/^CDX\s+/i, "")).join(", "), [rows]);
  const info = useMemo(() => creditFooterInfo(sourceLine, !!payload, resource.data?.stale, spreadEqRanked ? [{
    id: "rank-basis", capture: true,
    parts: [{ text: `${spreadEqRanked} pctl on spread eq`, tone: "muted" as const }],
    variants: [[{ text: "pctl on spread eq", tone: "muted" as const }]],
  }] : []), [payload, sourceLine, resource.data?.stale, spreadEqRanked]);
  usePaneStatusFooter({
    registrationId: "cdx",
    loading,
    error: resource.error ?? resource.data?.refreshError ?? null,
    info,
  });

  // The 1W and 1M moves, HY and EM's price as a spread and the print count ride beside the board's own 1D column.
  const spreads = rows.some((row) => row.index.spreadBp !== undefined);
  const extraColumns = useMemo(() => [
    {
      column: { id: "week", label: "1W", width: 10, align: "right" as const },
      sortValue: (row: CdxRow) => row.week,
      renderCell: (row: CdxRow) => ({
        text: formatMove(row.index.quote, row.day.change1W),
        color: signedMoveColor(row.week, row.adverseMove, theme),
      }),
    },
    {
      column: { id: "month", label: "1M", width: 10, align: "right" as const },
      sortValue: (row: CdxRow) => row.month,
      renderCell: (row: CdxRow) => ({
        text: formatMove(row.index.quote, row.day.change1M),
        color: signedMoveColor(row.month, row.adverseMove, theme),
      }),
    },
    // A server that predates the spread equivalent sends none: no column of blanks.
    ...(spreads ? [{
      column: { id: "spread", label: "SPREAD EQ", width: 9, align: "right" as const },
      sortValue: (row: CdxRow) => row.index.quote === "price" ? row.index.spreadBp ?? null : null,
      renderCell: (row: CdxRow) => ({
        text: row.index.quote === "price" ? formatLevel("spread", row.index.spreadBp ?? null) : MISSING_VALUE,
        color: theme.textMuted,
      }),
    }] : []),
    {
      column: { id: "prints", label: "PRINTS", width: 7, align: "right" as const },
      sortValue: (row: CdxRow) => row.index.prints,
      renderCell: (row: CdxRow) => ({
        text: row.index.prints == null ? MISSING_VALUE : String(row.index.prints),
        color: theme.textMuted,
      }),
    },
  ], [theme, spreads]);

  // The selected index's history sits above the board; the legend names it. What a command named (`HY`, `itraxx
  // main`) is read like `fn` reads it, and one the board does not have leaves the board on its first.
  const named = selectedId ? findIndex(payload?.indexes ?? [], selectedId) : null;
  return (
    <CreditBoardView rows={rows} width={width} height={height} focused={focused} loading={loading} error={resource.error}
      loadingLabel="Loading index CDS..." subject="Index CDS"
      selectedId={selectedId} namedId={named?.id} onSelectedIdChange={setSelectedId} openId={openId} onOpenIdChange={setOpenId}
      labelHeader="INDEX" labelWidth={16} valueLabel="5Y" valueWidth={9} extraColumns={extraColumns} historyTarget={historyTarget}
      renderDetail={(row, detailHeight) => <IndexDetail row={row} width={width} height={detailHeight} focused={focused} />} />
  );
}
