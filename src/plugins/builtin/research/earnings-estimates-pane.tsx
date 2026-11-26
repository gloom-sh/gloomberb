import { useCallback, useEffect, useMemo } from "react";
import { Box, TextAttributes } from "../../../ui";
import {
  buildSectionedRows,
  ChartTableHeader,
  DataTableStackView,
  EMPTY_TABLE_CELL,
  isSectionedItemRow,
  renderSectionedRowHeader,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  usePaneTabs,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type SectionedRow,
} from "../../../components";
import { fitChartTableColumns } from "../../../components/chart-table";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { colors } from "../../../theme/colors";
import type { AnalystEstimateRecord } from "../../../types/financials";
import { formatFilingDate } from "../../../utils/datetime-format";
import { MISSING_VALUE, formatPercent } from "../../../utils/format";
import { isNotMeaningful, NOT_MEANINGFUL_TEXT } from "../../../utils/growth";
import { usePaneSettingValue } from "../../../state/app/context";
import { usePluginPaneState } from "../../runtime";
import { SignInWall } from "../cloud/auth-actions";
import { useCompanyDisclosureLinks } from "../company-kpis/related";
import { useEventRowDetail } from "./event-detail";
import { useEventData } from "./event-data";
import { buildEarningsHeader, estimateRate, formatEventMetric, forwardEstimates, type EventRow } from "./event-model";
import { EventsEarningsView, toStat } from "./event-views";

type EstimateColumnId =
  | "period" | "ends"
  | "eps" | "epsLow" | "epsHigh" | "epsGrowth" | "epsAnalysts"
  | "revenue" | "revenueLow" | "revenueHigh" | "revenueGrowth" | "revenueAnalysts";
type EstimateColumn = DataTableColumn & { id: EstimateColumnId };
type EstimateItem = SectionedRow<EventRow>;

/** One currency every amount of a metric is in, to head its column with; none when they differ or one is unstated. */
function sharedEstimateCurrency(rows: readonly EventRow[], metric: "eps" | "revenue"): string | undefined {
  const currencies = new Set(rows.flatMap((row) => {
    const estimate = row.estimateInputs?.[metric];
    return estimate?.average == null ? [] : [estimate.currency ?? ""];
  }));
  const [only] = currencies;
  return currencies.size === 1 && only ? only : undefined;
}

/**
 * The Estimates view's columns: the period, then each metric's consensus with
 * its low and high, its growth on the year before and the analysts behind it.
 * Narrow, the counts go first (the detail keeps them), then the ranges, the
 * period end and growth.
 */
export function estimateColumns(width: number, units: { eps?: string; revenue?: string } = {}): EstimateColumn[] {
  const heading = (label: string, unit: string | undefined) => (unit ? `${label} ${unit}` : label);
  return fitChartTableColumns<EstimateColumn>([
    { id: "period", label: "PERIOD", width: 9, align: "left" },
    { id: "ends", label: "ENDS", width: 11, align: "left" },
    { id: "eps", label: heading("EPS", units.eps), width: Math.max(7, heading("EPS", units.eps).length), align: "right" },
    { id: "epsLow", label: "EPS LOW", width: 7, align: "right", title: "Lowest EPS estimate" },
    { id: "epsHigh", label: "EPS HIGH", width: 8, align: "right", title: "Highest EPS estimate" },
    { id: "epsGrowth", label: "EPS Y/Y", width: 8, align: "right", title: "EPS estimate over the year-ago figure" },
    { id: "epsAnalysts", label: "EPS ESTS", width: 8, align: "right", title: "Analysts behind the EPS estimate" },
    { id: "revenue", label: heading("REVENUE", units.revenue), width: Math.max(9, heading("REVENUE", units.revenue).length), align: "right" },
    { id: "revenueLow", label: "REV LOW", width: 8, align: "right", title: "Lowest revenue estimate" },
    { id: "revenueHigh", label: "REV HIGH", width: 8, align: "right", title: "Highest revenue estimate" },
    { id: "revenueGrowth", label: "REV Y/Y", width: 8, align: "right", title: "Revenue estimate over the year-ago figure" },
    { id: "revenueAnalysts", label: "REV ESTS", width: 8, align: "right", title: "Analysts behind the revenue estimate" },
  ], width, [["epsAnalysts", "revenueAnalysts"], ["revenueLow", "revenueHigh"], ["epsLow", "epsHigh"], "ends", "revenueGrowth", "epsGrowth"]);
}

/** The forward estimates in sections, quarters then years, each nearest first. */
function estimateItems(rows: readonly EventRow[]): EstimateItem[] {
  const { quarters, years } = forwardEstimates(rows);
  return buildSectionedRows([{ label: "Quarters", items: quarters }, { label: "Years", items: years }], (row) => row.id);
}

/** What a `?` after an amount means, in the footer's notes rather than a line of its own over the table. */
const UNSTATED_CURRENCY_NOTE = "? after an amount: its source stated no currency";

function growthCell(estimate: AnalystEstimateRecord | undefined): DataTableCell {
  const rate = estimateRate(estimate);
  if (isNotMeaningful(rate)) return { text: NOT_MEANINGFUL_TEXT, color: colors.textDim };
  if (rate == null) return { text: MISSING_VALUE, color: colors.textDim };
  return { text: formatPercent(rate), value: rate * 100, color: rate > 0 ? colors.positive : rate < 0 ? colors.negative : colors.textDim };
}

/**
 * EE's Estimates view: the consensus for the quarters and years ahead, each
 * with its range, its growth on the year before and its analysts, under the
 * next report and the trailing twelve months. Enter opens a period's inputs.
 */
function EstimatesView({ focused, width, height, footerPaneId }: { focused: boolean; width: number; height: number; footerPaneId: string }) {
  const {
    symbol, ticker, exchange, cloudSession, fund, actionsData, analystData, today, allRows,
    sourceNotice, loading, authWall, error, reload,
  } = useEventData("earnings-estimates");
  useCompanyDisclosureLinks(symbol);
  const rows = useMemo(() => allRows.filter((row) => row.status === "Q Est" || row.status === "FY Est"), [allRows]);
  const items = useMemo(() => estimateItems(rows), [rows]);
  const epsUnit = useMemo(() => sharedEstimateCurrency(rows, "eps"), [rows]);
  const revenueUnit = useMemo(() => sharedEstimateCurrency(rows, "revenue"), [rows]);
  const hasUnstatedCurrency = rows.some((row) => (["eps", "revenue"] as const).some((metric) => {
    const estimate = row.estimateInputs?.[metric];
    return estimate?.average != null && !estimate.currency;
  }));
  const columns = useMemo(() => estimateColumns(width, { eps: epsUnit, revenue: revenueUnit }), [epsUnit, revenueUnit, width]);
  const figures = useMemo(() => buildEarningsHeader(allRows, { today, fund }).map(toStat), [allRows, fund, today]);

  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("selectedKey", null);
  // Until one is picked, the nearest quarter.
  const selected = rows.find((row) => row.id === selectedKey) ?? items.find(isSectionedItemRow)?.item ?? null;
  const [openRowId, setOpenRowId] = usePluginPaneState<string | null>("openRowId", null);
  const openRow = openRowId ? rows.find((row) => row.id === openRowId) ?? null : null;
  const detail = useEventRowDetail(openRow, { symbol, exchange, ticker, width });
  // A period no longer estimated (a layout saved before its report) closes once the rows are in, not while they load.
  useEffect(() => {
    if (openRowId && !openRow && !loading) setOpenRowId(null);
  }, [loading, openRow, openRowId, setOpenRowId]);

  const renderCell = useCallback((item: EstimateItem, column: EstimateColumn): DataTableCell => {
    if (!isSectionedItemRow(item)) return EMPTY_TABLE_CELL;
    const row = item.item;
    const eps = row.estimateInputs?.eps;
    const revenue = row.estimateInputs?.revenue;
    // Bare under the currency its column is headed with, with its own code otherwise, `?` when its source stated none.
    const amount = (estimate: AnalystEstimateRecord | undefined, value: number | undefined, unit: string | undefined, kind: "eps" | "revenue", color: string): DataTableCell => {
      const text = formatEventMetric(value, unit ? undefined : estimate?.currency, kind);
      return { text: value != null && !estimate?.currency ? `${text} ?` : text, ...(value != null ? { value } : {}), color };
    };
    const analysts = (estimate: AnalystEstimateRecord | undefined): DataTableCell =>
      estimate?.analysts == null ? { text: MISSING_VALUE, color: colors.textDim } : { text: String(estimate.analysts), value: estimate.analysts, color: colors.textDim };
    switch (column.id) {
      case "period": return { text: row.period, color: colors.textBright, attributes: TextAttributes.BOLD };
      // Day-first as the Reported view dates its quarters; the ISO day still sorts and exports.
      case "ends": return { text: formatFilingDate(row.date, row.date), value: row.date, color: colors.textDim };
      case "eps": return amount(eps, eps?.average, epsUnit, "eps", colors.text);
      case "epsLow": return amount(eps, eps?.low, epsUnit, "eps", colors.textDim);
      case "epsHigh": return amount(eps, eps?.high, epsUnit, "eps", colors.textDim);
      case "epsGrowth": return growthCell(eps);
      case "epsAnalysts": return analysts(eps);
      case "revenue": return amount(revenue, revenue?.average, revenueUnit, "revenue", colors.text);
      case "revenueLow": return amount(revenue, revenue?.low, revenueUnit, "revenue", colors.textDim);
      case "revenueHigh": return amount(revenue, revenue?.high, revenueUnit, "revenue", colors.textDim);
      case "revenueGrowth": return growthCell(revenue);
      case "revenueAnalysts": return analysts(revenue);
    }
  }, [epsUnit, revenueUnit]);

  const loadError = error ?? (sourceNotice?.failed ? sourceNotice.text : null);
  usePaneStatusFooter({
    registrationId: footerPaneId,
    loading,
    error: loadError,
    emptyResult: !!(actionsData || analystData) && !rows.length && !sourceNotice,
  });
  usePaneNoticeFooter({
    registrationId: `${footerPaneId}:source-notices`,
    notices: [
      ...(sourceNotice && !sourceNotice.failed ? [sourceNotice.text] : []),
      ...(hasUnstatedCurrency ? [UNSTATED_CURRENCY_NOTE] : []),
    ],
    focused: focused && !openRow,
    enabled: !authWall && rows.length > 0 && !openRow,
    title: "Event data",
  });
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => handleRefreshKey(event, reload, { stopPropagation: true }), [reload]);

  if (authWall) return <SignInWall placement="earnings-estimates-signin" action="view earnings estimates" needsVerification={cloudSession.needsVerification} />;

  return (
    <DataTableStackView<EstimateItem, EstimateColumn>
      focused={focused}
      detailOpen={!!openRow}
      onBack={() => setOpenRowId(null)}
      detailContent={detail.content}
      detailTitle={detail.title}
      detailScrollRef={detail.scrollRef}
      onActivate={(item) => {
        if (!isSectionedItemRow(item)) return;
        // Back lands on the period that was open.
        setSelectedKey(item.item.id);
        setOpenRowId(item.item.id);
      }}
      rootWidth={width}
      rootHeight={height}
      rootBefore={figures.length ? (
        <ChartTableHeader width={width} height={height} tableRows={items.length} tableColumns={columns} figures={figures} />
      ) : undefined}
      onRootKeyDown={handleKeyDown}
      columns={columns}
      items={items}
      getItemKey={(item) => item.key}
      isNavigable={isSectionedItemRow}
      renderSectionHeader={renderSectionedRowHeader}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      sortColumnId={null}
      sortDirection="asc"
      resetScrollKey={symbol ?? ""}
      selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (item) => item.key, onChange: (id) => setSelectedKey(String(id)) }}
      getExportMetadata={() => [
        ...(epsUnit ? [["EPS currency", epsUnit]] : []),
        ...(revenueUnit ? [["Revenue currency", revenueUnit]] : []),
        ...(hasUnstatedCurrency ? [["?", "Currency unstated"]] : []),
      ]}
      status={{ loading: loading && !rows.length, error: !loading && !rows.length ? loadError : null, subject: "earnings estimates" }}
      emptyStateTitle={sourceNotice?.text ?? "No earnings estimates"}
    />
  );
}

type EstimatesPaneView = "estimates" | "reported";
const EE_VIEWS: ReadonlyArray<{ value: EstimatesPaneView; label: string }> = [
  { value: "estimates", label: "Estimates" },
  { value: "reported", label: "Reported" },
];
const isEstimatesPaneView = (value: unknown): value is EstimatesPaneView => value === "estimates" || value === "reported";

/**
 * EE: the forward estimates and the reported quarters as two views under one
 * strip, each with its own columns, both under the next report and the
 * trailing twelve months. Reported is EVT's Earnings view, chart over table.
 * Each opens a row's detail (an estimate's inputs; a report's EPS comparison
 * and SEC filing), which they keep under one key, so a layout saved with a
 * row open opens on it, in the view it was opened in.
 */
export function EarningsEstimatesView({ focused, width, height, footerPaneId = "earnings-estimates" }: {
  focused: boolean;
  width: number;
  height: number;
  footerPaneId?: string;
}) {
  const [chosen, setChosen] = usePluginPaneState<EstimatesPaneView | null>("eeView", null);
  const [openRowId, setOpenRowId] = usePluginPaneState<string | null>("openRowId", null);
  // A layout's or `shot`'s `view` setting opens on that view; a choice made in the pane wins.
  const [requested] = usePaneSettingValue<string>("view", "");
  // A layout saved before EE had views opens on the view its open row is in: a report's, or else the estimates.
  const shown: EstimatesPaneView = chosen ?? (isEstimatesPaneView(requested) ? requested : openRowId?.startsWith("earn:") ? "reported" : "estimates");
  // A row opened keeps its view with the layout.
  useEffect(() => {
    if (openRowId && !chosen) setChosen(shown);
  }, [chosen, openRowId, setChosen, shown]);
  const select = useCallback((value: string) => {
    if (!isEstimatesPaneView(value)) return;
    setChosen(value);
    setOpenRowId(null);
  }, [setChosen, setOpenRowId]);
  const { strip, rows } = usePaneTabs({ tabs: [...EE_VIEWS], activeValue: shown, onSelect: select, focused, dense: true });
  const bodyHeight = Math.max(1, height - rows);
  return (
    <Box flexDirection="column" width={width} height={height}>
      {strip}
      {shown === "reported"
        ? <EventsEarningsView estimates focused={focused} width={width} height={bodyHeight} footerPaneId={footerPaneId} />
        : <EstimatesView focused={focused} width={width} height={bodyHeight} footerPaneId={footerPaneId} />}
    </Box>
  );
}
