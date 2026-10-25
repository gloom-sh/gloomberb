import { useCallback, useMemo, useState } from "react";
import {
  ChartTableHeader,
  DataTableView,
  PaneStatusBody,
  QueryBar,
  stackedSeries,
  useTableLayoutWidth,
  type DataTableCell,
  type DataTableKeyEvent,
  type StatItem,
} from "../../../components";
import { formatCompactAxis } from "../../../components/chart-table";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import type { DefiTvlPayload } from "../../../api-client/crypto-markets";
import { colors, priceColor } from "../../../theme/colors";
import { SERIES_COLORS } from "../../../theme/series-colors";
import { formatCompact, formatCompactAmount } from "../../../utils/format";
import { usePluginPaneState } from "../../runtime";
import {
  buildDefiColumns,
  buildDefiRows,
  DEFAULT_DEFI_SORT,
  DEFI_LISTS,
  defiFailure,
  defiHistory,
  defiHistoryStart,
  defiListAsOf,
  nextDefiSort,
  sortDefiRows,
  type DefiColumn,
  type DefiList,
  type DefiRow,
  type DefiSortPreference,
} from "./defi";
import { formatCryptoPercent } from "./model";
import { SUPPLY_RANGES, type SupplyRangeId } from "./supply";

const RANGE_OPTIONS = SUPPLY_RANGES.map(({ value, label }) => ({ value, label }));
const LIST_OPTIONS = DEFI_LISTS.map(({ value, label }) => ({ value, label }));

const formatTvl = (value: number) => formatCompact(value, { fixedDecimals: true });

function signedPercent(value: number | null): DataTableCell {
  return { text: formatCryptoPercent(value), color: value == null ? colors.textDim : priceColor(value) };
}

function signedAmount(value: number | null): DataTableCell {
  return {
    text: value == null ? "—" : formatCompactAmount(value, { signed: true }),
    color: value == null ? colors.textDim : priceColor(value),
  };
}

function renderDefiCell(row: DefiRow, column: DefiColumn): DataTableCell {
  switch (column.id) {
    case "rank":
      return { text: String(row.rank), color: colors.textDim };
    case "name":
      return { text: row.name, color: colors.textBright };
    case "detail":
      return { text: row.detail ?? "—", color: colors.textDim };
    case "tvl":
      return { text: formatTvl(row.tvl) };
    case "change1dPercent":
      return signedPercent(row.change1dPercent);
    case "change7d":
      return signedAmount(row.change7d);
    case "change7dPercent":
      return signedPercent(row.change7dPercent);
    case "change30d":
      return signedAmount(row.change30d);
    case "change30dPercent":
      return signedPercent(row.change30dPercent);
    case "share":
      return { text: row.share == null ? "—" : `${row.share.toFixed(2)}%`, color: colors.textDim };
    case "chains":
      return { text: row.chains == null ? "—" : String(row.chains), color: colors.textDim };
  }
}

/** A TVL change as a figure: the amount, its percent beside it, coloured by direction. */
function changeFigure(id: string, label: string, amount: number | null, percent: number | null): StatItem {
  return {
    id,
    label,
    value: amount == null ? "—" : formatCompactAmount(amount, { signed: true }),
    detail: formatCryptoPercent(percent),
    ...(amount == null ? {} : { color: priceColor(amount) }),
  };
}

export interface DefiResourceState {
  payload: DefiTvlPayload | null;
  loading: boolean;
  error: string | null;
  reload: () => unknown;
}

/**
 * CRYP's DeFi tab: the total DeFi TVL with its 7D and 30D change, its daily
 * history, and the largest protocols or chains below. Every figure carries its
 * date and who measures it, and the history says the day it starts.
 */
export function DefiTvlView({
  width,
  height,
  focused,
  resource,
}: {
  width: number;
  height: number;
  focused: boolean;
  resource: DefiResourceState;
}) {
  const tableLayoutWidth = useTableLayoutWidth(width);
  const { payload } = resource;
  const [list, setList] = usePluginPaneState<DefiList>("defiList", "protocol");
  const [range, setRange] = usePluginPaneState<SupplyRangeId>("defiRange", "1Y");
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("defiSelected", null);
  const [sort, setSort] = useState<DefiSortPreference>(DEFAULT_DEFI_SORT);
  const rows = useMemo(() => sortDefiRows(buildDefiRows(payload, list), sort), [list, payload, sort]);
  const columns = useMemo(() => buildDefiColumns(tableLayoutWidth, list), [list, tableLayoutWidth]);
  // A chain's figures are the total's day, which its figure dates; protocols are read live, so they say when.
  const listAsOf = list === "protocol" ? defiListAsOf(payload, list) : null;

  const series = useMemo(() => {
    const history = defiHistory(payload, range);
    if (!history) return [];
    return stackedSeries(history.dates, [{ id: "tvl", label: "DeFi TVL", color: SERIES_COLORS[0]!, values: history.values }], { calendarSpaced: true });
  }, [payload, range]);
  const figures = useMemo<StatItem[]>(() => {
    const total = payload?.total;
    if (!payload || !total) return [];
    const since = defiHistoryStart(payload);
    return [
      { id: "total", label: "Total DeFi TVL", value: formatTvl(total.tvl), ...(payload.asOf ? { detail: `as of ${payload.asOf}` } : {}) },
      changeFigure("change-7d", "7D change", total.change7d, total.change7dPercent),
      changeFigure("change-30d", "30D change", total.change30d, total.change30dPercent),
      { id: "source", label: "Source", value: payload.source.name, ...(since ? { detail: `daily since ${since}` } : {}) },
    ];
  }, [payload]);

  const reload = resource.reload;
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => (
    handleRefreshKey(event, () => { void reload(); }, { stopPropagation: true })
  ), [reload]);

  const failure = !payload && resource.error ? defiFailure(resource.error) : null;

  return (
    <PaneStatusBody
      loading={resource.loading && !payload}
      // The failure names DeFi TVL itself, so it is the title and is said once.
      error={failure}
      errorTitle={failure ?? undefined}
      subject="DeFi TVL"
      empty={!!payload && !payload.total && !rows.length}
      emptyTitle="No DeFi TVL yet."
    >
      <DataTableView<DefiRow, DefiColumn>
        focused={focused}
        selection={{
          kind: "id",
          selectedId: selectedId && rows.some((row) => row.id === selectedId) ? selectedId : rows[0]?.id ?? null,
          getId: (row) => row.id,
          onChange: (id) => setSelectedId(id),
        }}
        onRootKeyDown={handleKeyDown}
        resetScrollKey={list}
        columns={columns}
        items={rows}
        sortable
        sortColumnId={sort.columnId}
        sortDirection={sort.direction}
        onHeaderClick={(columnId) => setSort((current) => nextDefiSort(current, columnId))}
        onSortChange={(columnId, direction) => setSort({ columnId: columnId as DefiSortPreference["columnId"], direction })}
        getItemKey={(row) => row.id}
        renderCell={renderDefiCell}
        selectedTextOverridesCellColor
        emptyStateTitle={list === "chain" ? "No chains returned." : "No protocols returned."}
        rootBefore={(
          <ChartTableHeader
            width={width}
            height={height}
            tableRows={rows.length}
            tableColumns={columns}
            query={(
              <QueryBar
                width={width}
                filters={[{
                  id: "list",
                  label: "List",
                  inline: true,
                  value: list,
                  options: LIST_OPTIONS,
                  onChange: (value: string) => {
                    setList(value === "chain" ? "chain" : "protocol");
                    setSelectedId(null);
                  },
                }]}
                view={{ value: range, options: RANGE_OPTIONS, onChange: setRange, chartRange: true }}
                {...(listAsOf ? { asOf: `as of ${listAsOf}` } : {})}
              />
            )}
            figures={figures}
            chart={{
              series,
              formatValue: formatTvl,
              formatAxisValue: formatCompactAxis,
              remoteKind: "defi-tvl-history",
              loading: resource.loading && !payload,
              empty: "No DeFi TVL history yet.",
            }}
          />
        )}
      />
    </PaneStatusBody>
  );
}
