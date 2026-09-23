import { useCallback, useMemo, useState } from "react";
import { Box } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import {
  DataTableStackView,
  PaneStatusBody,
  CompositeChart,
  StatGrid,
  statGridRows,
  type StatItem,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  type DataTableColumn,
} from "../../../components";
import {
  useAsyncResource,
  useAutoRefresh,
  usePaneCollection,
  usePaneSettingValue,
  usePaneTitle,
  usePluginPaneState,
  useShortcut,
  useTickers,
} from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { ApiRequestError } from "../../../api-client/errors";
import type { PaneProps } from "../../../types/plugin";
import { ScatterTrailSurface } from "../../../components/chart/static/trail-chart-surface";
import {
  staticSeries,
  scalarPoint,
} from "../../../components/chart/static/series";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedRotation, loadRotation } from "./client";
import {
  ROTATION_LIMIT,
  rotationId,
  rotationTrailWeeks,
  rotationInstruments,
  sectorRotationInstruments,
  type RotationInstrument,
  type RotationRow,
} from "./model";

// One hue per sector ETF, in the sector board's order (XLK, XLV, XLF, XLY,
// XLC, XLI, XLP, XLE, XLU, XLRE, XLB): no two trails share a colour family.
const PALETTE = [
  "#4da3ff",
  "#ff9933",
  "#a78bfa",
  "#4ade80",
  "#ff5c5c",
  "#facc15",
  "#22d3ee",
  "#f472b6",
  "#a3e635",
  "#b5835a",
  "#94a3b8",
];
// The observation week is the same for every row, so it lives in the footer.
// Percentiles rank against the trailing year of weekly readings.
const COLUMNS: DataTableColumn[] = [
  { id: "symbol", label: "ETF", width: 7, align: "left" },
  { id: "label", label: "NAME", width: 16, flexGrow: 1, align: "left" },
  { id: "quadrant", label: "QUADRANT", width: 10, align: "left" },
  { id: "strength", label: "STRENGTH", width: 10, align: "right" },
  { id: "strengthRank", label: "STR PCTL", width: 8, align: "right" },
  { id: "momentum", label: "MOMENTUM", width: 10, align: "right" },
  { id: "momentumRank", label: "MOM PCTL", width: 8, align: "right" },
];
const clearDenied = (error: unknown) =>
  error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
const number = (value: number | null | undefined) =>
  value == null ? "--" : value.toFixed(2);
const rank = (value: number | null) =>
  value == null ? "--" : value.toFixed(0);
const PANELS = [{ id: "main" }];
function RotationDetail({
  row,
  width,
  height,
  focused = false,
}: {
  row: RotationRow;
  width: number;
  height: number;
  focused?: boolean;
}) {
  const colors = useThemeColors();
  const series = useMemo(
    () =>
      ["strength", "momentum"].map((metric, index) =>
        staticSeries(
          row.history
            .slice(-53)
            .map((point) =>
              scalarPoint(
                new Date(point.date),
                point[metric as "strength" | "momentum"],
              ),
            ),
          {
            id: metric,
            label: metric === "strength" ? "Strength" : "Momentum",
            color: index ? colors.warning : colors.positive,
            calendarSpaced: true,
          },
        ),
      ),
    [row, colors],
  );
  // A thin percentile window is flagged in the footer notices, and the footer
  // carries the observation week every row shares, so neither repeats here.
  const rankDetail = (value: RotationRow["strengthRank"]) => `${rank(value.percentile)} pctl`;
  const stats: StatItem[] = [
    { id: "strength", label: "Strength", value: number(row.strength), detail: rankDetail(row.strengthRank) },
    { id: "momentum", label: "Momentum", value: number(row.momentum), detail: rankDetail(row.momentumRank) },
    { id: "quadrant", label: "Quadrant", value: row.quadrant ?? "--" },
  ];
  const statRows = statGridRows(stats, width);
  return (
    <Box width={width} height={height} flexDirection="column">
      <StatGrid items={stats} width={width} />
      <CompositeChart
        series={series}
        panels={PANELS}
        width={width}
        height={Math.max(4, height - statRows)}
        focused={focused}
        navigable={false}
        showTimeAxis
        formatAxisValue={(value) => value.toFixed(1)}
      />
    </Box>
  );
}
export function RelativeRotationPane(props: PaneProps) {
  const [scope] = usePaneSettingValue("scope", "sectors");
  const [symbols] = usePaneSettingValue("symbols", "");
  const [benchmarkText] = usePaneSettingValue("benchmark", "SPY:NYSEARCA");
  const [trailText] = usePaneSettingValue("trail", "6");
  const { collectionId } = usePaneCollection();
  const tickers = useTickers();
  const context = useMemo(() => {
    try {
      const references = rotationInstruments(benchmarkText || "SPY:NYSEARCA");
      if (references.length !== 1)
        throw new Error("Choose one benchmark in pane settings.");
      const instruments =
        scope === "custom"
          ? rotationInstruments(symbols)
          : scope === "collection"
            ? Object.values(tickers)
                .filter(
                  (ticker) =>
                    collectionId &&
                    [
                      ...ticker.metadata.watchlists,
                      ...ticker.metadata.portfolios,
                    ].includes(collectionId),
                )
                .map((ticker) => ({
                  symbol: ticker.metadata.symbol,
                  exchange: ticker.metadata.exchange,
                  label: ticker.metadata.symbol,
                }))
            : sectorRotationInstruments();
      if (!instruments.length)
        throw new Error(
          "Choose symbols or link a populated watchlist in pane settings.",
        );
      if (instruments.length > ROTATION_LIMIT)
        throw new Error(
          `Choose a watchlist with at most ${ROTATION_LIMIT} instruments.`,
        );
      return { benchmark: references[0]!, instruments, error: null };
    } catch (error) {
      return {
        benchmark: null,
        instruments: [],
        error:
          error instanceof Error ? error.message : "Invalid rotation scope.",
      };
    }
  }, [scope, symbols, benchmarkText, collectionId, tickers]);
  const trail = rotationTrailWeeks(trailText);
  return context.benchmark ? (
    <RotationView
      key={`${rotationId(context.benchmark)}:${context.instruments.map(rotationId).join(",")}:${trail}`}
      {...props}
      benchmark={context.benchmark}
      instruments={context.instruments}
      trail={trail}
    />
  ) : (
    <PaneStatusBody error={context.error} subject="relative rotation" />
  );
}
function RotationView({
  width,
  height,
  focused,
  benchmark,
  instruments,
  trail,
}: PaneProps & {
  benchmark: RotationInstrument;
  instruments: RotationInstrument[];
  trail: number;
}) {
  const session = useResearchCloudSession();
  const identity = `${rotationId(benchmark)}:${instruments.map(rotationId).join(",")}:${trail}`;
  const loader = useCallback(
    (force: boolean) => loadRotation(benchmark, instruments, trail, force),
    [identity, session.requestKey],
  );
  const resource = useAsyncResource(loader, {
    initialData: () => cachedRotation(benchmark, instruments, trail),
    clearOnError: clearDenied,
  });
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>(
    "selected",
    null,
  );
  const [openId, setOpenId] = usePluginPaneState<string | null>("open", null);
  const [sort, setSort] = useState({
    id: "symbol",
    direction: "asc" as "asc" | "desc",
  });
  const data = resource.data?.payload;
  const selected = data?.rows.find((row) => row.id === openId);
  const colorMap = useMemo(
    () =>
      new Map(
        instruments.map((row, index) => [
          rotationId(row),
          PALETTE[index % PALETTE.length]!,
        ]),
      ),
    [identity],
  );
  const trails = useMemo(
    () =>
      data?.rows.map((row) => ({
        id: row.id,
        label: row.symbol,
        color: colorMap.get(row.id)!,
        points: row.trail
          .filter((point) => point.strength != null && point.momentum != null)
          .map((point) => ({
            x: point.strength!,
            y: point.momentum!,
            date: point.date,
          })),
      })) ?? [],
    [data, colorMap],
  );
  const rows = useMemo(
    () =>
      [...(data?.rows ?? [])].sort((a, b) => {
        const value = (row: RotationRow) =>
          sort.id === "strengthRank"
            ? row.strengthRank.percentile
            : sort.id === "momentumRank"
              ? row.momentumRank.percentile
              : row[sort.id as "symbol"];
        const left = value(a),
          right = value(b);
        return left == null
          ? right == null
            ? 0
            : 1
          : right == null
            ? -1
            : (typeof left === "number" && typeof right === "number"
                ? left - right
                : String(left).localeCompare(String(right))) *
              (sort.direction === "asc" ? 1 : -1);
      }),
    [data, sort],
  );
  const tableHeight = Math.min(
    rows.length + 2,
    Math.max(4, Math.floor(height * 0.42)),
  );
  const chartHeight = Math.max(6, height - tableHeight);
  usePaneTitle(`RRG vs ${benchmark.symbol}`);
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => {
    if (focused && isPlainKey(event, "r") && !event.targetEditable) {
      event.preventDefault();
      void resource.reload();
    }
  });
  usePaneNoticeFooter({
    registrationId: "relative-rotation:notices",
    focused,
    notices: [
      ...(data?.gaps ?? []),
      ...(data?.rows.flatMap((row) =>
        row.gaps.map((gap) => `${row.symbol}: ${gap}`),
      ) ?? []),
      ...(resource.data?.refreshError ? [resource.data.refreshError] : []),
    ],
  });
  usePaneStatusFooter({
    registrationId: "relative-rotation",
    loading: resource.loading,
    error: resource.error,
    info: data
      ? [
          {
            id: "asof",
            parts: [
              {
                text: `${data.currency ?? "--"} · week ${data.asOf ?? "unavailable"} · ${trail}W trails`,
                tone: "muted",
              },
            ],
          },
          ...(resource.data?.stale
            ? [
                {
                  id: "stale",
                  parts: [{ text: "stale", tone: "warning" as const }],
                },
              ]
            : []),
        ]
      : [],
  });
  return (
    <Box width={width} height={height} flexDirection="column">
      <PaneStatusBody
        loading={resource.loading && !data}
        error={!data ? resource.error : null}
        subject="relative rotation"
      >
        {data ? (
          <>
            {!selected ? (
              <ScatterTrailSurface
                trails={trails}
                width={width}
                height={chartHeight}
                selectedId={selectedId}
                xLabel={`Strength vs ${benchmark.symbol}`}
              />
            ) : null}
            <DataTableStackView
              columns={COLUMNS}
              items={rows}
              focused={focused}
              rootWidth={width}
              rootHeight={tableHeight}
              getItemKey={(row) => row.id}
              selection={{
                kind: "id",
                selectedId,
                getId: (row) => row.id,
                onChange: setSelectedId,
              }}
              onActivate={(row) => setOpenId(row.id)}
              detailOpen={!!selected}
              onBack={() => setOpenId(null)}
              detailTitle={selected?.label}
              detailContent={
                selected ? (
                  <RotationDetail
                    row={selected}
                    width={width}
                    height={Math.max(5, height - 2)}
                    focused={focused}
                  />
                ) : null
              }
              sortColumnId={sort.id}
              sortDirection={sort.direction}
              onHeaderClick={(id) =>
                setSort({
                  id,
                  direction:
                    sort.id === id && sort.direction === "asc" ? "desc" : "asc",
                })
              }
              renderCell={(row, column) => ({
                text:
                  column.id === "strengthRank"
                    ? rank(row.strengthRank.percentile)
                    : column.id === "momentumRank"
                      ? rank(row.momentumRank.percentile)
                      : column.id === "strength" || column.id === "momentum"
                        ? number(row[column.id])
                        : String(row[column.id as "symbol"] ?? "--"),
                color: column.id === "symbol" ? colorMap.get(row.id) : undefined,
              })}
              emptyStateTitle="No aligned weekly observations."
            />
          </>
        ) : null}
      </PaneStatusBody>
    </Box>
  );
}
