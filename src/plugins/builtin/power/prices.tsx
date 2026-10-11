import { useCallback, useMemo } from "react";
import type { CarbonBoard, PowerPriceRow } from "../../../api-client/europe-energy";
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
import { getCachedCarbonPrice, getCachedPowerPrices, loadCarbonHistory, loadCarbonPrice, loadPowerPriceHistory, loadPowerPrices, POWER_PRICES_NOT_AVAILABLE, validateCarbonPrice, validatePowerPrices } from "./prices-client";
import { CARBON_PRICE_UNIT, CARBON_SELECTION, DEFAULT_PRICE_MARKET, formatPowerChange, formatPowerPrice, POWER_PRICE_UNIT, powerPriceMarket, powerRangePosition } from "./prices-model";

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

function historySeries(row: Pick<PowerPriceRow, "code" | "name" | "date">, points: ReadonlyArray<{ date: string; value: number }>, color: string, days?: number,
  label = `${row.name} day-ahead`) {
  const from = days && row.date ? new Date(Date.parse(`${row.date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10) : "";
  return [staticSeries(points.filter((point) => point.date >= from).map((point) => {
    const date = new Date(`${point.date}T00:00:00Z`);
    return { date, observedAt: date, value: point.value };
  }), { id: `day-ahead:${row.code}`, label, color, calendarSpaced: true })];
}

const compactTonnes = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(2)}M t` : `${Math.round(value / 1e3)}k t`;

/**
 * The EU carbon allowance above the board: its latest auction day's price,
 * how it moved, and how the latest general-allowance auction was covered.
 */
function carbonFigures(board: CarbonBoard): StatItem[] {
  const row = board.row;
  if (row.price == null) return [];
  const latest = board.auctions.find((auction) => !auction.aviation && auction.price != null);
  return [
    { id: "eua", label: `EUA ${CARBON_PRICE_UNIT}`, value: formatPowerPrice(row.price), detail: row.date ?? undefined },
    { id: "eua-change", label: "EUA 1D", value: formatPowerChange(row.change), ...(row.previousDate ? { detail: `vs ${row.previousDate}` } : {}) },
    { id: "eua-30d", label: "EUA 30D avg", value: formatPowerPrice(row.average30) },
    { id: "eua-1y", label: "EUA 1Y ago", value: formatPowerPrice(row.yearAgo), ...(row.yearAgoDate ? { detail: row.yearAgoDate } : {}) },
    ...(latest?.coverRatio != null ? [{ id: "eua-cover", label: "EUA cover", value: `${latest.coverRatio.toFixed(2)}x`,
      detail: [latest.zone, compactTonnes(latest.volume)].filter(Boolean).join(" ") }] : []),
  ];
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
 * board and its whole history in the detail. The EU carbon allowance's
 * auction price sits in the figures above, in its own unit.
 */
export function PowerPricesView({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [openingTab] = usePaneSettingValue("tab", "queue");
  const [, setTab] = usePluginPaneState<string>("power:tab", openingTab);
  // `EPWR DE` opens with the market in the instance params, `EPWR EUA` with the carbon allowance; a saved selection wins.
  const params = usePaneInstance()?.params;
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("power:prices:selected", powerPriceMarket(params?.market)?.code ?? null);
  const [carbonMode, setCarbonMode] = usePluginPaneState("power:prices:carbon", params?.market === CARBON_SELECTION);
  const [openId, setOpenId] = usePluginPaneState<string | null>("power:prices:open", null);
  // `shot` freezes the boards and the charted history, so the capture and its check read the same days.
  const [snapshotSetting] = usePaneSettingValue<PowerPricesSnapshot | null>("powerPricesSnapshot", null);
  const snapshot = useMemo(() => {
    try {
      return snapshotSetting ? { ...snapshotSetting, board: validatePowerPrices(snapshotSetting.board),
        carbon: snapshotSetting.carbon ? validateCarbonPrice(snapshotSetting.carbon) : null } : null;
    } catch { return null; }
  }, [snapshotSetting]);
  const resource = useAsyncResource(snapshot ? null : loadPowerPrices, { initialData: getCachedPowerPrices });
  const board = snapshot?.board ?? resource.data?.payload ?? null;
  // The carbon allowance loads beside the board; its failure is a notice, never the board's.
  const carbonResource = useAsyncResource(snapshot ? null : loadCarbonPrice, { initialData: getCachedCarbonPrice });
  const carbon = snapshot ? snapshot.carbon : carbonResource.data?.payload ?? null;
  const figures = useMemo(() => carbon ? carbonFigures(carbon) : [], [carbon]);
  const rows = useMemo(() => board?.rows.map(boardRow) ?? [], [board]);
  // The band charts the selected market, or the carbon allowance from `c` or EPWR EUA until a market is chosen.
  const carbonCharted = carbonMode && !!carbon?.row.date;
  const selected = rows.find((row) => row.id === selectedId) ?? rows.find((row) => row.id === DEFAULT_PRICE_MARKET) ?? rows[0];
  const selectMarket = useCallback((id: string) => { setSelectedId(id); setCarbonMode(false); }, [setSelectedId, setCarbonMode]);
  const code = carbonCharted ? CARBON_SELECTION : selected?.price.date ? selected.id : null;
  const historyLoader = useCallback((force: boolean) => code === CARBON_SELECTION ? loadCarbonHistory(force) : loadPowerPriceHistory(code!, force), [code]);
  const loaded = useAsyncResource<{ payload: { code: string; points: ReadonlyArray<{ date: string; value: number }> } }>(
    code && !snapshot ? historyLoader : null, { keepPreviousData: true });
  const history = snapshot ? { ...loaded, data: snapshot.history ? { payload: snapshot.history } : null, loading: false, error: null } : loaded;
  usePowerPricesEvidence(board, carbon, useMemo(() => rows.map((row) => row.id), [rows]), resource.loading || history.loading || carbonResource.loading);
  useAutoRefresh(resource.updatedAt, resource.load);
  useAutoRefresh(carbonResource.updatedAt, carbonResource.load);
  usePaneRefreshKey(() => { void resource.reload(); void history.reload(); void carbonResource.reload(); }, { focused });
  const { strip, rows: tabRows } = usePaneTabs({ tabs: [...POWER_TABS], activeValue: "prices", onSelect: (tab: string) => setTab(tab), focused, dense: true });
  const notAvailable = !board && resource.error === POWER_PRICES_NOT_AVAILABLE;
  const open = rows.find((row) => row.id === openId);
  const charted = carbonCharted ? carbon!.row : selected?.price;
  const unit = carbonCharted ? CARBON_PRICE_UNIT : POWER_PRICE_UNIT;
  const series = useMemo(() => charted && history.data?.payload.code === charted.code
    ? historySeries(charted, history.data.payload.points, carbonCharted ? colors.positive : colors.warning, CHART_DAYS, carbonCharted ? "EU carbon (EUA) auction" : undefined)
    : [], [charted, carbonCharted, history.data, colors.warning, colors.positive]);
  const sourceUrl = board?.source.url;
  const chartExpression = carbonCharted ? "CAP:carbon:eua" : selected?.price.date ? `CAP:day-ahead:${selected.id.toLowerCase()}` : null;
  const hints: PaneHint[] = [
    ...(sourceUrl ? [{ id: "source", key: "o", label: `pen ${carbonCharted ? carbon!.source.name : board!.source.name}`, title: "Open the publisher's page",
      onPress: () => void host.openExternal(carbonCharted ? carbon!.source.url : sourceUrl) }] : []),
    ...(chartExpression ? [{ id: "chart", key: "g", label: "raph", title: "Chart in a custom chart",
      onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: chartExpression }) }] : []),
    ...(figures.length && !carbonCharted ? [{ id: "carbon", key: "c", label: "arbon", title: "Chart the EU carbon auction price above the board",
      onPress: () => setCarbonMode(true) }] : []),
  ];
  usePaneStatusFooter({ registrationId: "power-prices", loading: resource.loading || history.loading,
    error: board ? resource.error ?? (open ? null : history.error) : null, stale: !!resource.data?.stale, hints });
  usePaneNoticeFooter({ registrationId: "power-prices:notices", focused,
    notices: [...(board?.gaps ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : []),
      ...(carbon?.gaps ?? []), ...(board && !carbon && carbonResource.error ? [carbonResource.error] : [])] });
  const bodyHeight = Math.max(3, height - tabRows);
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={resource.loading && !board} error={!board && !notAvailable ? resource.error : null}
      empty={notAvailable} emptyTitle={POWER_PRICES_NOT_AVAILABLE} subject="power prices" width={width} height={bodyHeight}>
      {board ? <MarketBoardStack rows={rows} width={width} height={bodyHeight} focused={focused}
        rootBefore={({ columns }) => <ChartTableHeader width={width} height={bodyHeight} tableRows={rows.length} tableColumns={columns}
          figures={figures} chart={charted ? { series, loading: history.loading && !series.length, empty: `No price history for ${charted.name}`,
            formatValue: (value) => `${formatPowerPrice(value)} ${unit}`, formatAxisValue: formatAxis, remoteKind: "day-ahead-history" } : null} />}
        selectedId={selected?.id ?? null} onSelectedIdChange={selectMarket} openId={open?.id ?? null} onOpenIdChange={setOpenId}
        labelHeader="MARKET" labelWidth={16} valueLabel={POWER_PRICE_UNIT} valueWidth={10} percentileLabel="IN 1Y" extraColumns={EXTRA_COLUMNS}
        emptyTitle={POWER_PRICES_NOT_AVAILABLE}
        renderDetail={(row) => <PriceDetail row={row.price} width={width} height={Math.max(5, bodyHeight - 2)} focused={focused} />} /> : null}
    </PaneStatusBody>
  </Box>;
}
