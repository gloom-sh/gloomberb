import { useCallback, useMemo } from "react";
import { Box, ScrollBox } from "../../../ui";
import {
  useAsyncResource,
  useAutoRefresh,
  usePluginPaneState,
  useShortcut,
  useUpdatedAgo,
} from "../../../public/react";
import {
  CompositeChart,
  KeyValueRow,
  MarketBoardStack,
  PaneStatusBody,
  Tabs,
  usePaneNoticeFooter,
  usePaneStatusLinkFooter,
  type MarketBoardStackProps,
} from "../../../components";
import { colors } from "../../../theme/colors";
import type { CryptoBoardRow } from "../../../api-client/crypto-board";
import { ApiRequestError } from "../../../api-client/errors";
import { staticSeries } from "../../../components/chart/static/series";
import type { PaneProps } from "../../../types/plugin";
import { formatCompact } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedCryptoBoard, loadCryptoBoard } from "./client";
import {
  cryptoBoardRow,
  cryptoNotices,
  cryptoPrice,
  cryptoRank,
  cryptoReturn,
  cryptoTimestamp,
  cryptoVolume,
  type CryptoMarketBoardRow,
} from "./model";
const PANELS = [{ id: "main" }];
const METRICS = [
  { value: "price", label: "Price" },
  { value: "volume", label: "Volume" },
];
const clearDenied = (error: unknown) =>
  error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
const EXTRA_COLUMNS: MarketBoardStackProps<CryptoMarketBoardRow>["extraColumns"] = [
  {
    column: { id: "return7d", label: "7D CLOSED", width: 11, align: "right" },
    sortValue: (row) => row.observation.return7d.valuePercent,
    renderCell: (row) => ({
      text: cryptoReturn(row.observation.return7d.valuePercent),
      color: colors.textMuted,
    }),
  },
  {
    column: { id: "baseVolume", label: "BASE VOL", width: 15, align: "right" },
    sortValue: (row) => row.observation.volume.value,
    renderCell: (row) => ({ text: cryptoVolume(row.observation), color: colors.textMuted }),
  },
];
function CryptoDetail({
  row,
  width,
  height,
  focused,
}: {
  row: CryptoBoardRow;
  width: number;
  height: number;
  focused: boolean;
}) {
  const [metric, setMetric] = usePluginPaneState("crypto:metric", "price");
  const series = useMemo(
    () => [
      staticSeries(
        row.history.map((point) => ({
          date: new Date(point.date),
          observedAt: new Date(point.date),
          value: metric === "volume" ? point.volume : point.close,
        })),
        {
          id: `${row.symbol}:${metric}`,
          label: metric === "volume" ? `Volume (${row.volume.unit})` : `${row.baseCurrency} / USD`,
          color: metric === "volume" ? colors.warning : colors.positive,
          calendarSpaced: true,
        },
      ),
    ],
    [row, metric],
  );
  const summaryHeight = Math.min(9, Math.max(3, height - 7));
  const p = row.price.percentile;
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Tabs tabs={METRICS} activeValue={metric} onSelect={setMetric} focused={focused} dense />
      <ScrollBox height={summaryHeight} flexShrink={0} scrollY>
        <Box paddingX={1} flexDirection="column">
          <KeyValueRow
            labelWidth={24}
            label="Latest trade USD"
            value={cryptoPrice(row.price.value)}
            detail={`${cryptoRank(p)} · ${cryptoTimestamp(row.price.asOf)}`}
          />
          <KeyValueRow
            labelWidth={24}
            label="Since prior UTC close"
            value={cryptoReturn(row.dailyChange.valuePercent)}
            detail={`${cryptoRank(row.dailyChange.percentile)} · versus ${row.dailyChange.referenceDate ?? "--"}`}
          />
          <KeyValueRow
            labelWidth={24}
            label="7D completed"
            value={cryptoReturn(row.return7d.valuePercent)}
            detail={`${cryptoRank(row.return7d.percentile)} · ${row.return7d.startDate} to ${row.return7d.endDate}`}
          />
          <KeyValueRow
            labelWidth={24}
            label="Completed base volume"
            value={cryptoVolume(row)}
            detail={`${cryptoRank(row.volume.percentile)} · ${row.volume.periodStart.slice(0, 10)} UTC`}
          />
          <KeyValueRow
            labelWidth={24}
            label="Price sample"
            value={`${p.sampleCount} daily closes`}
            detail={`${p.historyStart ?? "--"} to ${p.historyEnd ?? "--"}`}
          />
          <KeyValueRow
            labelWidth={24}
            label="1Y price range USD"
            value={`${cryptoPrice(p.min)} to ${cryptoPrice(p.max)}`}
          />
          <KeyValueRow labelWidth={24} label="Bar prices" value="Trades and quote midpoints" />
          <KeyValueRow
            labelWidth={24}
            label="Quote-only days"
            value={String(row.coverage.quoteOnlyDays)}
            detail="zero reported traded volume"
          />
          <KeyValueRow labelWidth={24} label="Missing days" value={String(row.coverage.missingDays)} />
        </Box>
      </ScrollBox>
      <PaneStatusBody
        empty={row.history.every((point) => (metric === "volume" ? point.volume : point.close) === null)}
        subject="crypto history"
        emptyTitle="No dated history available."
      >
        <CompositeChart
          series={series}
          panels={PANELS}
          width={width}
          height={Math.max(3, height - summaryHeight - 1)}
          showLegend={false}
          navigable={false}
          showTimeAxis
          formatAxisValue={metric === "volume" ? (value) => formatCompact(value) : cryptoPrice}
          remoteKind="crypto-board-history"
        />
      </PaneStatusBody>
    </Box>
  );
}
export function CryptoBoardPane({ width, height, focused }: PaneProps) {
  const session = useResearchCloudSession();
  const loader = useCallback((force: boolean) => loadCryptoBoard(force), [session.requestKey]);
  const resource = useAsyncResource(loader, { initialData: cachedCryptoBoard, clearOnError: clearDenied });
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("open", null);
  const data = resource.data?.payload;
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  // useUpdatedAgo supplies the existing minute clock so retained trades also age while offline.
  const rows = useMemo(() => data?.rows.map((row) => cryptoBoardRow(row)) ?? [], [data, updatedAgo]);
  const freshAsOf = rows
    .flatMap((row) => (row.value != null && row.asOf ? [row.asOf] : []))
    .sort()
    .at(-1);
  const stalePrices = rows.filter((row) => row.status === "stale").length;
  const unavailablePrices = rows.filter((row) => row.status === "unavailable").length;
  const completedDate = data?.rows[0]?.volume.periodStart.slice(0, 10);
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => {
    if (focused && isPlainKey(event, "r")) {
      event.preventDefault();
      void resource.reload();
    }
  });
  usePaneNoticeFooter({
    registrationId: "crypto-board:notices",
    focused,
    notices: [
      ...(data ? cryptoNotices(data) : []),
      ...(resource.data?.refreshError ? [resource.data.refreshError] : []),
    ],
  });
  usePaneStatusLinkFooter({
    registrationId: "crypto-board",
    focused,
    loading: resource.loading,
    error: resource.error,
    url: data?.source.methodologyUrl ?? null,
    showOpenHint: true,
    info: data
      ? [
          ...(freshAsOf
            ? [{ id: "as-of", parts: [{ text: cryptoTimestamp(freshAsOf), tone: "muted" as const }] }]
            : []),
          ...(stalePrices
            ? [{ id: "stale-prices", parts: [{ text: `${stalePrices} stale`, tone: "warning" as const }] }]
            : []),
          ...(unavailablePrices
            ? [
                {
                  id: "missing-prices",
                  parts: [{ text: `${unavailablePrices} unavailable`, tone: "warning" as const }],
                },
              ]
            : []),
          ...(resource.data?.stale
            ? [{ id: "cache", parts: [{ text: "cached", tone: "warning" as const }] }]
            : []),
        ]
      : [],
  });
  return (
    <Box width={width} height={height} flexDirection="column">
      <PaneStatusBody
        loading={resource.loading && !data}
        error={!data ? resource.error : null}
        subject="crypto board"
        empty={!resource.loading && !resource.error && !!data && !rows.length}
      >
        {data ? (
          <MarketBoardStack
            rows={rows}
            width={width}
            height={height}
            focused={focused}
            selectedId={selectedId}
            onSelectedIdChange={setSelectedId}
            openId={openId}
            onOpenIdChange={setOpenId}
            labelWidth={10}
            valueLabel="USD"
            valueWidth={13}
            changeLabel="UTC DAY"
            percentileLabel="PCTL"
            asOfWidth={12}
            extraColumns={EXTRA_COLUMNS}
            rootBefore={
              completedDate ? (
                <Box paddingX={1}>
                  <KeyValueRow
                    labelWidth={24}
                    label="Completed UTC day"
                    value={completedDate}
                    detail="7D returns and base volume"
                  />
                </Box>
              ) : undefined
            }
            renderDetail={(row) => (
              <CryptoDetail
                row={row.observation}
                width={width}
                height={Math.max(5, height - 2)}
                focused={focused}
              />
            )}
          />
        ) : null}
      </PaneStatusBody>
    </Box>
  );
}
