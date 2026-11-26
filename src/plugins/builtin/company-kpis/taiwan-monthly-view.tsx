import { useCallback, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import type {
  TaiwanBoardRow,
  TaiwanRevenuePoint,
} from "../../../api-client/taiwan-revenue";
import {
  CompositeChart,
  DataTableView,
  PaneStatusBody,
  StatGrid,
  type DataTableCell,
  type StatItem,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, TextAttributes, useRendererHost } from "../../../ui";
import { MISSING_VALUE } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { logFailure } from "../../../utils/log-failure";
import { usePluginAppActions } from "../../runtime";
import {
  buildBasketRevenueSeries,
  buildMonthlyRevenueSeries,
  fmtSignedPct,
  fmtTwdB,
  stockMonthlyColumns,
  supplierBoardColumns,
} from "./taiwan-monthly-model";

const CHART_PANELS = [{ id: "main" }];

export function TaiwanMonthlyStockView({
  code,
  width,
  height,
  focused,
}: {
  code: string;
  width: number;
  height: number;
  focused: boolean;
}) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const load = useCallback(() => apiClient.getTaiwanStockRevenue(code, 36), [code]);
  const res = useAsyncResource(load);
  const data = res.data;

  const stats = useMemo<StatItem[]>(() => {
    if (!data) return [];
    const { latest, company } = data;
    return [
      { id: "rev", essential: true, label: `Rev (${latest.yearMonth})`, value: fmtTwdB(latest.revenueTwdB) },
      {
        id: "yoy",
        essential: true,
        label: "YoY %",
        value: fmtSignedPct(latest.yoyPct),
        detail: `Accel ${fmtSignedPct(latest.yoyAccelPp, "pp")}`,
        tone: (latest.yoyPct ?? 0) >= 0 ? "positive" : "negative",
      },
      {
        id: "mom",
        essential: true,
        label: "MoM %",
        value: fmtSignedPct(latest.momPct),
        tone: (latest.momPct ?? 0) >= 0 ? "positive" : "negative",
      },
      {
        id: "ytd-yoy",
        label: "YTD YoY",
        value: fmtSignedPct(latest.ytdYoyPct),
        tone: (latest.ytdYoyPct ?? 0) >= 0 ? "positive" : "negative",
      },
      {
        id: "streak",
        label: "3M Avg / Streak",
        value: fmtSignedPct(data.threeMonthAvgYoyPct),
        detail: `${data.consecutiveYoyGrowthMonths}m +YoY`,
      },
      ...(company.linkedUsTickers.length > 0
        ? [{ id: "us-links", label: "US Links", value: company.linkedUsTickers.slice(0, 4).join(", ") }]
        : []),
    ];
  }, [data]);

  const series = useMemo(
    () =>
      data
        ? buildMonthlyRevenueSeries(data.history, {
            revenue: colors.warning,
            yoy: colors.positive,
          })
        : [],
    [data, colors.warning, colors.positive],
  );

  const columns = useMemo(() => stockMonthlyColumns(width), [width]);
  const showChart = height >= 20 && series.length > 0;
  const chartHeight = showChart ? Math.min(10, Math.max(7, Math.floor(height * 0.34))) : 0;

  const handleKey = useCallback(
    (key: Parameters<typeof handleRefreshKey>[0]) => {
      if (handleRefreshKey(key, res.reload, { stopPropagation: true })) return true;
      if (isPlainKey(key, "o") && data) {
        const row = data.history.find((h) => h.yearMonth === selectedMonth) ?? data.latest;
        if (row?.sourceUrl) {
          void host.openExternal(row.sourceUrl).catch(logFailure("taiwan-revenue", "open external filing failed"));
        }
        return true;
      }
      return false;
    },
    [data, host, res.reload, selectedMonth],
  );

  return (
    <PaneStatusBody
      loading={!data && res.loading}
      error={!data ? res.error : null}
      empty={!data && !res.loading && !res.error}
      emptyTitle={`No Taiwan monthly revenue history for ${code}.`}
      subject="Taiwan monthly revenue"
    >
      {data ? (
        <Box flexDirection="column" flexGrow={1} minHeight={0}>
          <StatGrid items={stats} width={width} />
          {showChart ? (
            <CompositeChart
              series={series}
              panels={CHART_PANELS}
              width={width}
              height={chartHeight}
              focused={false}
              navigable={false}
              showLegend
              showTimeAxis
              formatValue={(v) => fmtTwdB(v)}
              formatAxisValue={(v) => `${Math.round(v)}B`}
              remoteKind="taiwan-monthly-revenue"
            />
          ) : null}
          <DataTableView<TaiwanRevenuePoint>
            focused={focused}
            rootWidth={width}
            columns={columns}
            items={data.history}
            sortColumnId="month"
            sortDirection="desc"
            emptyStateTitle="No monthly revenue records."
            getItemKey={(row) => row.yearMonth}
            selection={{
              kind: "id",
              selectedId: selectedMonth,
              getId: (r) => r.yearMonth,
              onChange: setSelectedMonth,
            }}
            onActivate={(row) => {
              void host.openExternal(row.sourceUrl).catch(logFailure("taiwan-revenue", "open external filing failed"));
            }}
            onRootKeyDown={handleKey}
            renderCell={(row, col): DataTableCell => {
              switch (col.id) {
                case "month":
                  return { text: row.yearMonth, color: colors.textBright, attributes: TextAttributes.BOLD };
                case "revenue":
                  return { text: fmtTwdB(row.revenueTwdB), value: row.revenueTwdB, color: colors.textBright };
                case "yoy":
                  return {
                    text: fmtSignedPct(row.yoyPct),
                    value: row.yoyPct ?? undefined,
                    color: (row.yoyPct ?? 0) >= 0 ? colors.positive : colors.negative,
                  };
                case "accel":
                  return {
                    text: fmtSignedPct(row.yoyAccelPp, "pp"),
                    value: row.yoyAccelPp ?? undefined,
                    color: (row.yoyAccelPp ?? 0) >= 0 ? colors.positive : colors.negative,
                  };
                case "mom":
                  return { text: fmtSignedPct(row.momPct), value: row.momPct ?? undefined, color: colors.textDim };
                case "ytdYoy":
                  return { text: fmtSignedPct(row.ytdYoyPct), value: row.ytdYoyPct ?? undefined, color: colors.text };
                default:
                  return { text: row.notes ?? MISSING_VALUE, color: colors.textDim };
              }
            }}
          />
        </Box>
      ) : null}
    </PaneStatusBody>
  );
}

export function TaiwanUsReadthroughView({
  usTicker,
  width,
  height,
  focused,
}: {
  usTicker: string;
  width: number;
  height: number;
  focused: boolean;
}) {
  const colors = useThemeColors();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  const load = useCallback(
    () => apiClient.getTaiwanUsReadthrough(usTicker, 24),
    [usTicker],
  );
  const res = useAsyncResource(load);
  const data = res.data;

  const stats = useMemo<StatItem[]>(() => {
    if (!data) return [];
    return [
      { id: "chain", essential: true, label: `${data.usTicker} TW Chain`, value: `${data.supplierCount} suppliers`, detail: data.latestMonth ?? undefined },
      { id: "agg-rev", essential: true, label: "Aggregate Sales", value: fmtTwdB(data.aggregateRevenueTwdB) },
      {
        id: "agg-yoy",
        essential: true,
        label: "Weighted YoY",
        value: fmtSignedPct(data.aggregateYoyPct),
        detail: `Accel ${fmtSignedPct(data.yoyAccelPp, "pp")}`,
        tone: (data.aggregateYoyPct ?? 0) >= 0 ? "positive" : "negative",
      },
      {
        id: "agg-mom",
        label: "Weighted MoM",
        value: fmtSignedPct(data.aggregateMomPct),
        tone: (data.aggregateMomPct ?? 0) >= 0 ? "positive" : "negative",
      },
    ];
  }, [data]);

  const series = useMemo(
    () => (data ? buildBasketRevenueSeries(data.series, { revenue: colors.warning }) : []),
    [data, colors.warning],
  );
  const columns = useMemo(() => supplierBoardColumns(width), [width]);
  const showChart = height >= 20 && series.length > 0;
  const chartHeight = showChart ? Math.min(10, Math.max(7, Math.floor(height * 0.34))) : 0;

  return (
    <PaneStatusBody
      loading={!data && res.loading}
      error={!data ? res.error : null}
      empty={!data && !res.loading && !res.error}
      emptyTitle={`No Taiwan supply-chain monthly revenue mapped for ${usTicker}.`}
      subject="Taiwan supply-chain revenue"
    >
      {data ? (
        <Box flexDirection="column" flexGrow={1} minHeight={0}>
          <StatGrid items={stats} width={width} />
          {showChart ? (
            <CompositeChart
              series={series}
              panels={CHART_PANELS}
              width={width}
              height={chartHeight}
              focused={false}
              navigable={false}
              showLegend
              showTimeAxis
              formatValue={(v) => fmtTwdB(v)}
              formatAxisValue={(v) => `${Math.round(v)}B`}
              remoteKind="taiwan-supply-chain-revenue"
            />
          ) : null}
          <DataTableView<TaiwanBoardRow>
            focused={focused}
            rootWidth={width}
            columns={columns}
            items={data.suppliers}
            sortColumnId="revenue"
            sortDirection="desc"
            emptyStateTitle="No mapped Taiwan suppliers."
            getItemKey={(row) => row.code}
            selection={{
              kind: "id",
              selectedId: selectedCode,
              getId: (r) => r.code,
              onChange: setSelectedCode,
            }}
            onActivate={(row) =>
              createPaneFromTemplate("company-kpis-pane", { symbol: row.symbol })
            }
            onRootKeyDown={(key) => handleRefreshKey(key, res.reload, { stopPropagation: true })}
            renderCell={(row, col): DataTableCell => {
              switch (col.id) {
                case "code":
                  return { text: row.code, color: colors.textBright, attributes: TextAttributes.BOLD };
                case "name":
                  return { text: row.nameEn ? `${row.nameEn} (${row.nameZh})` : row.nameZh, color: colors.text };
                case "revenue":
                  return { text: fmtTwdB(row.revenueTwdB), value: row.revenueTwdB, color: colors.textBright };
                case "yoy":
                  return {
                    text: fmtSignedPct(row.yoyPct),
                    value: row.yoyPct ?? undefined,
                    color: (row.yoyPct ?? 0) >= 0 ? colors.positive : colors.negative,
                  };
                case "accel":
                  return {
                    text: fmtSignedPct(row.yoyAccelPp, "pp"),
                    value: row.yoyAccelPp ?? undefined,
                    color: (row.yoyAccelPp ?? 0) >= 0 ? colors.positive : colors.negative,
                  };
                case "mom":
                  return { text: fmtSignedPct(row.momPct), value: row.momPct ?? undefined, color: colors.textDim };
                default:
                  return { text: fmtSignedPct(row.ytdYoyPct), value: row.ytdYoyPct ?? undefined, color: colors.text };
              }
            }}
          />
        </Box>
      ) : null}
    </PaneStatusBody>
  );
}
