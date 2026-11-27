import { useCallback, useMemo } from "react";
import { ChartTableHeader, formatBpAxis, MarketBoardStack, PaneStatusBody, type StatItem } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { signedMoveColor, StatChartDetail } from "../../../components/market-board";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { formatPercentileRank } from "../../../utils/format";
import { useAssetData, usePluginPaneState } from "../../runtime";
import { FIXED_INCOME_PANE_ID } from "../fixed-income/model";
import { useCommandValue } from "../shared/command-tab";
import { reportFooterSegment } from "../shared/source-footer";
import { CreditHistoryChart, creditFooterInfo, creditHistoryChart, type CreditHistoryTarget } from "./board-shared";
import { getCachedSovrBoard, loadCurrencyMoves, loadSovrBoard } from "./client";
import { sovrHeadless } from "./headless";
import { readsInBatches } from "../../../market-data/batched-reads";
import {
  findSovereign,
  formatContract,
  formatCurrencyMove,
  formatLevel,
  formatMove,
  SETTLEMENT_TEXT,
  sovrRows,
  type SovrRow,
} from "./model";

const EMPTY_ROWS: SovrRow[] = [];
const NO_MOVES = new Map<string, number | null>();
const historyTarget = (row: SovrRow): CreditHistoryTarget => ({
  id: row.id, label: row.label, points: row.sovereign.points, quote: "spread",
  formatAxisValue: formatBpAxis, remoteKind: "sovr-history",
});

function SovereignDetail({ row, width, height, focused }: { row: SovrRow; width: number; height: number; focused: boolean }) {
  const { sovereign, year } = row;
  const items: StatItem[] = [
    { id: "level", label: "5Y spread", value: formatLevel("spread", sovereign.level),
      detail: [formatPercentileRank(year.percentile, "1Y"), sovereign.date, ...(sovereign.kind === "settlement" ? [SETTLEMENT_TEXT] : [])].join(" · ") },
    { id: "1m", label: "1M", value: formatMove("spread", sovereign.change1M) },
    { id: "1w", label: "1W", value: formatMove("spread", sovereign.change1W) },
    { id: "fx", label: "Currency 1M", value: formatCurrencyMove(sovereign.currency, row.currencyMove) },
    { id: "range", label: "1Y range", value: `${formatLevel("spread", year.low)} to ${formatLevel("spread", year.high)}` },
    { id: "contract", label: "Contract", value: formatContract(sovereign.maturity),
      detail: `${sovereign.prints} prints, ${sovereign.reported} with spread` },
  ];
  const target = useMemo(() => historyTarget(row), [row]);
  return (
    <StatChartDetail items={items} width={width} height={height} empty={sovereign.points.length < 3}
      emptySubject="spread history" emptyTitle="No history available."
      renderChart={(chartHeight) => <CreditHistoryChart target={target} width={width} height={chartHeight} focused={focused} />} />
  );
}

export function SovrPane({ focused, width, height }: PaneProps) {
  const theme = useThemeColors();
  const provider = useAssetData();
  const resource = useAsyncResource(loadSovrBoard, { initialData: getCachedSovrBoard });
  const { loading, load: refresh, reload } = resource;
  const payload = resource.data?.payload ?? null;
  // `SOVR Brazil` opens on that country, named as `fn SOVR Brazil` names it; a later `SOVR Chile` replaces it.
  const [selectedId, setSelectedId] = useCommandValue<string | null>(
    FIXED_INCOME_PANE_ID,
    "sovr:selected",
    (params) => params.view === "sovereign" && params.country ? params.country : null,
    null,
  );
  const [openId, setOpenId] = usePluginPaneState<string | null>("sovr:open", null);
  useAutoRefresh(resource.updatedAt, refresh);

  // Each currency's month against the dollar, from the same daily closes the FX panes use.
  const currencies = useMemo(() => [...new Set(payload?.sovereigns.map((row) => row.currency) ?? [])].sort().join(","),
    [payload]);
  const movesLoader = useCallback(async () => {
    if (!provider || !currencies) return NO_MOVES;
    // Every currency at once, in batch requests, from a source that batches them; a few at a time otherwise.
    const batch = await readsInBatches(provider, "getPriceHistory");
    return loadCurrencyMoves(currencies.split(","), (symbol) => provider.getPriceHistory(symbol, "", "3M", batch ? { batch } : undefined), batch);
  }, [currencies, provider]);
  const moves = useAsyncResource(movesLoader, { keepPreviousData: true });
  const rows = useMemo(() => payload ? sovrRows(payload.sovereigns, payload.asOf, moves.data ?? NO_MOVES) : EMPTY_ROWS,
    [moves.data, payload]);
  usePaneRefreshKey(() => {
    reload();
    moves.reload();
  }, { focused, enabled: !loading });

  // Its source and the newest day the rows carry, not when the response was put together, as `fn SOVR` ends.
  // The clock says the prints are delayed, so the line does not again.
  const sourceLine = useMemo(() => payload
    ? reportFooterSegment(sovrHeadless, { rows: payload.sovereigns.map((sovereign) => ({ date: sovereign.date })) }, { feed: false })
    : null, [payload]);
  const info = useMemo(() => creditFooterInfo(sourceLine, !!payload, resource.data?.stale), [payload, sourceLine, resource.data?.stale]);
  usePaneStatusFooter({
    registrationId: "sovr",
    loading: loading || moves.loading,
    error: resource.error ?? resource.data?.refreshError ?? null,
    info,
  });

  const movesPending = moves.loading && !moves.data;
  const extraColumns = useMemo(() => [{
    column: { id: "currency", label: "CCY 1M", width: 11, align: "right" as const },
    sortValue: (row: SovrRow) => row.currencyMove,
    renderCell: (row: SovrRow) => ({
      text: movesPending ? `${row.sovereign.currency} ...` : formatCurrencyMove(row.sovereign.currency, row.currencyMove),
      // A weaker local currency is the adverse move.
      color: signedMoveColor(row.currencyMove, "down", theme),
    }),
  }], [movesPending, theme]);

  if (rows.length === 0) {
    return (
      <PaneStatusBody loading={loading} error={resource.error} empty={!loading && !resource.error}
        loadingLabel="Loading sovereign CDS..." subject="Sovereign CDS" align="center" width={width} height={height} />
    );
  }

  // A country the command named that the board does not have leaves the board on its first.
  const named = selectedId ? findSovereign(payload?.sovereigns ?? [], selectedId) : null;
  const selected = rows.find((row) => row.id === selectedId) ?? rows.find((row) => row.id === named?.id) ?? rows[0];
  return (
    <MarketBoardStack rows={rows} width={width} height={height} focused={focused}
      rootBefore={({ columns }) => <ChartTableHeader width={width} height={height} tableRows={rows.length}
        tableColumns={columns} chart={selected ? creditHistoryChart(historyTarget(selected)) : null} />}
      selectedId={selected?.id ?? null} onSelectedIdChange={setSelectedId} openId={openId} onOpenIdChange={setOpenId}
      labelHeader="SOVEREIGN" labelWidth={18} valueLabel="5Y" valueWidth={9} changeLabel="1M" signedChange
      extraColumns={extraColumns}
      renderDetail={(row) => <SovereignDetail row={row} width={width} height={Math.max(5, height - 2)} focused={focused} />} />
  );
}
