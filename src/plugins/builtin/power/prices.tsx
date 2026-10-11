import { useCallback, useMemo } from "react";
import type { PowerPriceRow } from "../../../api-client/europe-energy";
import {
  ChartTableHeader, CompositeChart, MarketBoardStack, PaneStatusBody, spanAxisFormatter, usePaneNoticeFooter, usePaneStatusFooter,
  usePaneTabs, type MarketBoardRow, type PaneHint, type StatItem,
} from "../../../components";
import { staticSeries } from "../../../components/chart/static/series";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { StatChartDetail } from "../../../components/market-board";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneInstance } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, useRendererHost } from "../../../ui";
import { POWER_TABS } from "./model";
import { usePowerPricesEvidence, type PowerPricesSnapshot } from "./evidence";
import { getCachedPowerPrices, loadPowerPriceHistory, loadPowerPrices, POWER_PRICES_NOT_AVAILABLE, validatePowerPrices } from "./prices-client";
import { DEFAULT_PRICE_MARKET, formatPowerChange, formatPowerPrice, POWER_PRICE_UNIT, powerPriceMarket, powerRangePosition } from "./prices-model";

const PANELS = [{ id: "main" }];
const DAY_MS = 86_400_000;
/** The board's chart: the selected market's year, as the 1Y figures read. */
const CHART_DAYS = 366;
const formatAxis = spanAxisFormatter((value, digits) => value.toFixed(digits));

interface PriceBoardRow extends MarketBoardRow { price: PowerPriceRow }

function boardRow(row: PowerPriceRow): PriceBoardRow {
  const position = powerRangePosition(row);
  return {
    id: row.code, label: row.name, value: row.price, valueText: formatPowerPrice(row.price),
    change: row.change, changeText: formatPowerChange(row.change),
    percentile: position, percentileText: position == null ? "--" : `${position}%`,
    asOf: row.date, status: row.price == null ? "unavailable" : "available",
    history: row.trail.map((point) => ({ date: new Date(`${point.date}T00:00:00Z`), close: point.value })),
    price: row,
  };
}

const average = (key: "average7" | "average30" | "yearAgo", header: string) => ({
  column: { id: key, label: header, width: 9, align: "right" as const },
  sortValue: (row: PriceBoardRow) => row.price[key],
  renderCell: (row: PriceBoardRow) => ({ text: formatPowerPrice(row.price[key]), ...(row.price[key] != null ? { value: row.price[key]! } : {}) }),
});
const EXTRA_COLUMNS = [average("average7", "7D AVG"), average("average30", "30D AVG"), average("yearAgo", "1Y AGO")];

function historySeries(row: PowerPriceRow, points: ReadonlyArray<{ date: string; value: number }>, color: string, days?: number) {
  const from = days && row.date ? new Date(Date.parse(`${row.date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10) : "";
  return [staticSeries(points.filter((point) => point.date >= from).map((point) => {
    const date = new Date(`${point.date}T00:00:00Z`);
    return { date, observedAt: date, value: point.value };
  }), { id: `day-ahead:${row.code}`, label: `${row.name} day-ahead`, color, calendarSpaced: true })];
}

function PriceDetail({ row, width, height, focused }: { row: PowerPriceRow; width: number; height: number; focused: boolean }) {
  const colors = useThemeColors();
  const loader = useCallback((force: boolean) => loadPowerPriceHistory(row.code, force), [row.code]);
  const history = useAsyncResource(loader, { keepPreviousData: true });
  const series = useMemo(() => historySeries(row, history.data?.payload.points ?? [], colors.warning), [row, history.data, colors.warning]);
  const items: StatItem[] = [
    { id: "price", label: POWER_PRICE_UNIT, value: formatPowerPrice(row.price), detail: row.date ?? undefined },
    { id: "change", label: "1D", value: formatPowerChange(row.change), detail: row.previousDate ? `vs ${row.previousDate}` : undefined },
    { id: "average7", label: "7D avg", value: formatPowerPrice(row.average7) },
    { id: "average30", label: "30D avg", value: formatPowerPrice(row.average30) },
    { id: "yearAgo", label: "1Y ago", value: formatPowerPrice(row.yearAgo), detail: row.yearAgoDate ?? undefined },
    { id: "range", label: "52W range", value: `${formatPowerPrice(row.low52w)} to ${formatPowerPrice(row.high52w)}` },
  ];
  return <StatChartDetail items={items} width={width} height={height} empty={!history.loading && series[0]!.points.length < 2}
    emptySubject="price history" emptyTitle={history.error ?? "No price history available."}
    renderChart={(chartHeight) => <CompositeChart series={series} panels={PANELS} width={width} height={chartHeight} focused={focused}
      showLegend navigable={false} showTimeAxis formatValue={(value) => `${formatPowerPrice(value)} ${POWER_PRICE_UNIT}`}
      formatAxisValue={formatAxis} remoteKind="day-ahead-history" />} />;
}

/**
 * POWER's Prices tab: every European market's latest day-ahead price, each
 * dated by its own delivery day, with the selected market's year above the
 * board and its whole history in the detail.
 */
export function PowerPricesView({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [openingTab] = usePaneSettingValue("tab", "queue");
  const [, setTab] = usePluginPaneState<string>("power:tab", openingTab);
  // `EPWR DE` opens with the market in the instance params; a saved selection wins.
  const params = usePaneInstance()?.params;
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("power:prices:selected", powerPriceMarket(params?.market)?.code ?? null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("power:prices:open", null);
  // `shot` freezes the board and the selected market's history, so the capture and its check read the same days.
  const [snapshotSetting] = usePaneSettingValue<PowerPricesSnapshot | null>("powerPricesSnapshot", null);
  const snapshot = useMemo(() => {
    try { return snapshotSetting ? { ...snapshotSetting, board: validatePowerPrices(snapshotSetting.board) } : null; } catch { return null; }
  }, [snapshotSetting]);
  const resource = useAsyncResource(snapshot ? null : loadPowerPrices, { initialData: getCachedPowerPrices });
  const board = snapshot?.board ?? resource.data?.payload ?? null;
  const rows = useMemo(() => board?.rows.map(boardRow) ?? [], [board]);
  const selected = rows.find((row) => row.id === selectedId) ?? rows.find((row) => row.id === DEFAULT_PRICE_MARKET) ?? rows[0];
  const code = selected?.price.date && !snapshot ? selected.id : null;
  const historyLoader = useCallback((force: boolean) => loadPowerPriceHistory(code!, force), [code]);
  const loaded = useAsyncResource(code ? historyLoader : null, { keepPreviousData: true });
  const history = snapshot ? { ...loaded, data: snapshot.history ? { payload: snapshot.history } : null, loading: false, error: null } : loaded;
  usePowerPricesEvidence(board, useMemo(() => rows.map((row) => row.id), [rows]), resource.loading || history.loading);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => { void resource.reload(); void history.reload(); }, { focused });
  const { strip, rows: tabRows } = usePaneTabs({ tabs: [...POWER_TABS], activeValue: "prices", onSelect: (tab: string) => setTab(tab), focused, dense: true });
  const notAvailable = !board && resource.error === POWER_PRICES_NOT_AVAILABLE;
  const open = rows.find((row) => row.id === openId);
  const series = useMemo(() => selected && history.data?.payload.code === selected.id
    ? historySeries(selected.price, history.data.payload.points, colors.warning, CHART_DAYS) : [], [selected, history.data, colors.warning]);
  const sourceUrl = board?.source.url;
  const hints: PaneHint[] = [
    ...(sourceUrl ? [{ id: "source", key: "o", label: `pen ${board!.source.name}`, title: "Open the publisher's dataset page", onPress: () => void host.openExternal(sourceUrl) }] : []),
    ...(selected?.price.date ? [{ id: "chart", key: "g", label: "raph", title: "Chart in a custom chart",
      onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: `CAP:day-ahead:${selected.id.toLowerCase()}` }) }] : []),
  ];
  usePaneStatusFooter({ registrationId: "power-prices", loading: resource.loading || history.loading,
    error: board ? resource.error ?? (open ? null : history.error) : null, stale: !!resource.data?.stale, hints });
  usePaneNoticeFooter({ registrationId: "power-prices:notices", focused,
    notices: [...(board?.gaps ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  const bodyHeight = Math.max(3, height - tabRows);
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={resource.loading && !board} error={!board && !notAvailable ? resource.error : null}
      empty={notAvailable} emptyTitle={POWER_PRICES_NOT_AVAILABLE} subject="power prices" width={width} height={bodyHeight}>
      {board ? <MarketBoardStack rows={rows} width={width} height={bodyHeight} focused={focused}
        rootBefore={({ columns }) => <ChartTableHeader width={width} height={bodyHeight} tableRows={rows.length} tableColumns={columns}
          chart={selected ? { series, loading: history.loading && !series.length, empty: `No price history for ${selected.label}`,
            formatValue: (value) => `${formatPowerPrice(value)} ${POWER_PRICE_UNIT}`, formatAxisValue: formatAxis, remoteKind: "day-ahead-history" } : null} />}
        selectedId={selected?.id ?? null} onSelectedIdChange={setSelectedId} openId={open?.id ?? null} onOpenIdChange={setOpenId}
        labelHeader="MARKET" labelWidth={16} valueLabel={POWER_PRICE_UNIT} valueWidth={10} percentileLabel="IN 1Y" extraColumns={EXTRA_COLUMNS}
        emptyTitle={POWER_PRICES_NOT_AVAILABLE}
        renderDetail={(row) => <PriceDetail row={row.price} width={width} height={Math.max(5, bodyHeight - 2)} focused={focused} />} /> : null}
    </PaneStatusBody>
  </Box>;
}
