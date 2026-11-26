import { useCallback, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import type {
  HkCbbcContractRow,
  HkCbbcSummary,
  HkCbbcZoneBucket,
} from "../../../api-client/hk-cbbc";
import {
  CompositeChart,
  DataTableView,
  PaneStatusBody,
  QueryBar,
  StatGrid,
  usePaneFooter,
  usePaneTabs,
  type DataTableCell,
  type StatItem,
} from "../../../components";
import { dayCell } from "../../../components/ui/day-cell";
import { handleRefreshKey, loadingErrorFooterInfo } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, TextAttributes } from "../../../ui";
import { MISSING_VALUE, formatNumber } from "../../../utils/format";
import {
  buildCbbcChartModel,
  CBBC_QUICK_UNDERLYINGS,
  CBBC_TABS,
  cbbcContractColumns,
  cbbcOverviewColumns,
  cbbcZoneColumns,
  fmtCbbcEquiv,
  fmtCbbcLevel,
  fmtDistPct,
  fmtHkd,
  type CbbcViewTab,
} from "./cbbc-model";

const CHART_PANELS = [{ id: "main" }];

export function CbbcPositioningView({
  initialUnderlying,
  width,
  height,
  focused,
}: {
  initialUnderlying: string;
  width: number;
  height: number;
  focused: boolean;
}) {
  const colors = useThemeColors();
  const [underlying, setUnderlying] = useState(initialUnderlying);
  const [activeTab, setActiveTab] = useState<CbbcViewTab>("zones");
  const [contractSide, setContractSide] = useState<"all" | "bull" | "bear">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadUnderlying = useCallback(
    () => apiClient.getHkCbbcUnderlying(underlying, 40),
    [underlying],
  );
  const loadOverview = useCallback(() => apiClient.getHkCbbcOverview(40), []);

  const underlyingRes = useAsyncResource(
    activeTab !== "overview" ? loadUnderlying : null,
  );
  const overviewRes = useAsyncResource(
    activeTab === "overview" ? loadOverview : null,
  );
  const activeRes = activeTab === "overview" ? overviewRes : underlyingRes;
  const data = underlyingRes.data;
  const summary = data?.summary ?? null;

  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs: [...CBBC_TABS],
    activeValue: activeTab,
    onSelect: (value) => {
      setActiveTab(value as CbbcViewTab);
      setSelectedId(null);
    },
    focused,
    dense: true,
  });

  usePaneFooter(
    "options-positioning-cbbc",
    () => ({
      info: [
        {
          id: "cbbc-asof",
          parts: [
            {
              text: summary
                ? `HKEX CBBC ${summary.displaySymbol} (${summary.underlyingName}) · ${summary.atDate}`
                : "HKEX CBBC Street Inventory",
              tone: "muted" as const,
            },
          ],
        },
        ...loadingErrorFooterInfo(activeRes.loading, activeRes.error),
      ],
      hints: [
        { id: "refresh", key: "r", label: "efresh", onPress: () => activeRes.reload() },
      ],
    }),
    [summary, activeRes],
  );

  const stats = useMemo<StatItem[]>(() => {
    if (!summary) return [];
    const bullPct = summary.bullRatioPct;
    return [
      { id: "spot", essential: true, label: "Ref Spot", value: fmtCbbcLevel(summary.spotLevel, summary.isIndex) },
      {
        id: "ratio",
        essential: true,
        label: "Bull / Bear",
        value:
          bullPct != null
            ? `${formatNumber(bullPct, 1)}% / ${formatNumber(100 - bullPct, 1)}%`
            : MISSING_VALUE,
        tone:
          bullPct == null
            ? undefined
            : bullPct >= 55
              ? "positive"
              : bullPct <= 45
                ? "negative"
                : undefined,
      },
      {
        id: "heavy-bull",
        essential: true,
        label: "Heavy Bull",
        value: fmtCbbcLevel(summary.heavyBullCallLow, summary.isIndex),
        detail: fmtCbbcEquiv(summary.heavyBullEquiv, summary.isIndex),
        tone: "positive",
      },
      {
        id: "heavy-bear",
        essential: true,
        label: "Heavy Bear",
        value: fmtCbbcLevel(summary.heavyBearCallLow, summary.isIndex),
        detail: fmtCbbcEquiv(summary.heavyBearEquiv, summary.isIndex),
        tone: "negative",
      },
      {
        id: "turnover",
        label: "Turnover",
        value: fmtHkd(summary.totalTurnoverHkd),
        detail: `${summary.contractsCount} cts · ${summary.mceCount} MCE`,
      },
    ];
  }, [summary]);

  const chartModel = useMemo(
    () =>
      data && summary
        ? buildCbbcChartModel(summary, data.bullZones, data.bearZones, {
            bull: colors.positive,
            bear: colors.negative,
          })
        : { series: [], orderedZones: [], spotRatio: null },
    [data, summary, colors.positive, colors.negative],
  );

  const zoneRows = useMemo<HkCbbcZoneBucket[]>(() => {
    if (!data) return [];
    // Show nearest Bear zones (highest down to spot) followed by nearest Bull zones (spot down)
    const bears = [...data.bearZones].slice(0, 12).reverse();
    const bulls = [...data.bullZones].slice(0, 12);
    return [...bears, ...bulls];
  }, [data]);

  const contractRows = useMemo<HkCbbcContractRow[]>(() => {
    if (!data) return [];
    if (contractSide === "bull") return data.topBullContracts;
    if (contractSide === "bear") return data.topBearContracts;
    return [...data.topBullContracts, ...data.topBearContracts].sort(
      (a, b) => b.equivUnits - a.equivUnits,
    );
  }, [data, contractSide]);

  const zoneCols = useMemo(() => cbbcZoneColumns(width), [width]);
  const contractCols = useMemo(() => cbbcContractColumns(width), [width]);
  const overviewCols = useMemo(() => cbbcOverviewColumns(width), [width]);

  const bodyHeight = Math.max(4, height - tabRows);
  const showChart =
    activeTab === "zones" && bodyHeight >= 20 && chartModel.series.length > 0;
  const chartHeight = showChart
    ? Math.min(11, Math.max(7, Math.floor(bodyHeight * 0.36)))
    : 0;

  const xAxis = useMemo(() => {
    if (!chartModel.orderedZones.length || !summary) return undefined;
    const total = chartModel.orderedZones.length;
    const step = Math.max(1, Math.floor(total / 5));
    const ticks = chartModel.orderedZones
      .map((z, idx) =>
        idx === 0 || idx === total - 1 || idx % step === 0
          ? {
              label: fmtCbbcLevel(z.zoneLow, summary.isIndex),
              ratio: total > 1 ? idx / (total - 1) : 0,
            }
          : null,
      )
      .filter((t): t is { label: string; ratio: number } => t !== null);
    const markers =
      chartModel.spotRatio != null
        ? [
            {
              id: "spot",
              xRatio: chartModel.spotRatio,
              label: `Spot ${fmtCbbcLevel(summary.spotLevel, summary.isIndex)}`,
              color: colors.warning,
            },
          ]
        : [];
    return {
      ticks,
      markers,
      formatCursor: (ratio: number) => {
        const idx = Math.min(
          total - 1,
          Math.max(0, Math.round(ratio * (total - 1))),
        );
        return chartModel.orderedZones[idx]?.label ?? "";
      },
    };
  }, [chartModel, summary, colors.warning]);

  const underlyingOptions = useMemo(() => {
    const exists = CBBC_QUICK_UNDERLYINGS.some((u) => u.value === underlying);
    return exists
      ? [...CBBC_QUICK_UNDERLYINGS]
      : [{ value: underlying, label: summary?.displaySymbol ?? underlying }, ...CBBC_QUICK_UNDERLYINGS];
  }, [underlying, summary?.displaySymbol]);

  return (
    <Box width={width} height={height} flexDirection="column">
      {tabStrip}

      {activeTab !== "overview" ? (
        <QueryBar
          width={width}
          filters={[
            {
              id: "underlying",
              label: "Underlying",
              value: underlying,
              options: underlyingOptions,
              onChange: (v: string) => {
                setUnderlying(v);
                setSelectedId(null);
              },
            },
            ...(activeTab === "contracts"
              ? [
                  {
                    id: "side",
                    label: "Side",
                    inline: true,
                    value: contractSide,
                    options: [
                      { value: "all", label: "All" },
                      { value: "bull", label: "Bull" },
                      { value: "bear", label: "Bear" },
                    ],
                    onChange: (v: string) =>
                      setContractSide(v as "all" | "bull" | "bear"),
                  },
                ]
              : []),
          ]}
        />
      ) : null}

      <PaneStatusBody
        loading={!activeRes.data && activeRes.loading}
        error={!activeRes.data ? activeRes.error : null}
        empty={!activeRes.data && !activeRes.loading && !activeRes.error}
        emptyTitle={`No HKEX CBBC street inventory found for ${underlying}.`}
        subject="HKEX CBBC positioning"
      >
        {activeTab === "overview" && overviewRes.data ? (
          <DataTableView<HkCbbcSummary>
            focused={focused}
            rootWidth={width}
            columns={overviewCols}
            items={overviewRes.data.topUnderlyings}
            sortColumnId="turnover"
            sortDirection="desc"
            emptyStateTitle="No HKEX CBBC underlyings available."
            getItemKey={(row) => row.underlyingCode}
            selection={{
              kind: "id",
              selectedId,
              getId: (r) => r.underlyingCode,
              onChange: setSelectedId,
            }}
            onActivate={(row) => {
              setUnderlying(row.underlyingCode);
              setActiveTab("zones");
              setSelectedId(null);
            }}
            onRootKeyDown={(key) => handleRefreshKey(key, activeRes.reload, { stopPropagation: true })}
            renderCell={(row, col): DataTableCell => {
              switch (col.id) {
                case "symbol":
                  return { text: row.displaySymbol, color: colors.textBright, attributes: TextAttributes.BOLD };
                case "name":
                  return { text: row.underlyingName, color: colors.text };
                case "spot":
                  return { text: fmtCbbcLevel(row.spotLevel, row.isIndex), color: colors.text };
                case "bullPct":
                  return {
                    text: row.bullRatioPct != null ? `${formatNumber(row.bullRatioPct, 1)}%` : MISSING_VALUE,
                    value: row.bullRatioPct ?? undefined,
                    color: (row.bullRatioPct ?? 50) >= 55 ? colors.positive : (row.bullRatioPct ?? 50) <= 45 ? colors.negative : colors.text,
                  };
                case "heavyBull":
                  return { text: fmtCbbcLevel(row.heavyBullCallLow, row.isIndex), color: colors.positive };
                case "heavyBear":
                  return { text: fmtCbbcLevel(row.heavyBearCallLow, row.isIndex), color: colors.negative };
                default:
                  return { text: fmtHkd(row.totalTurnoverHkd), value: row.totalTurnoverHkd, color: colors.textDim };
              }
            }}
          />
        ) : data && summary ? (
          <Box flexDirection="column" flexGrow={1} minHeight={0}>
            <StatGrid items={stats} width={width} />
            {showChart ? (
              <CompositeChart
                series={chartModel.series}
                panels={CHART_PANELS}
                width={width}
                height={chartHeight}
                focused={false}
                navigable={false}
                showLegend
                showTimeAxis
                xAxis={xAxis}
                formatValue={(v) => fmtCbbcEquiv(v, summary.isIndex)}
                formatAxisValue={(v) => fmtCbbcEquiv(v, summary.isIndex)}
                remoteKind="hk-cbbc-zones"
              />
            ) : null}

            {activeTab === "zones" ? (
              <DataTableView<HkCbbcZoneBucket>
                focused={focused}
                rootWidth={width}
                columns={zoneCols}
                items={zoneRows}
                sortColumnId="zone"
                sortDirection="desc"
                emptyStateTitle="No active CBBC knock-out zones."
                getItemKey={(row) => `${row.direction}:${row.zoneLow}`}
                selection={{
                  kind: "id",
                  selectedId,
                  getId: (r) => `${r.direction}:${r.zoneLow}`,
                  onChange: setSelectedId,
                }}
                onRootKeyDown={(key) => handleRefreshKey(key, activeRes.reload, { stopPropagation: true })}
                renderCell={(row, col): DataTableCell => {
                  const isBull = row.direction === "bull";
                  const sideColor = isBull ? colors.positive : colors.negative;
                  switch (col.id) {
                    case "zone":
                      return {
                        text: row.label,
                        color: row.isHeavyZone ? colors.textBright : colors.text,
                        attributes: row.isHeavyZone ? TextAttributes.BOLD : undefined,
                      };
                    case "side":
                      return { text: isBull ? "BULL" : "BEAR", color: sideColor, attributes: TextAttributes.BOLD };
                    case "dist":
                      return { text: fmtDistPct(row.distancePct), value: row.distancePct ?? undefined, color: colors.textDim };
                    case "equiv":
                      return {
                        text: fmtCbbcEquiv(row.equivFutures ?? row.equivUnits, summary.isIndex),
                        value: row.equivFutures ?? row.equivUnits,
                        color: sideColor,
                      };
                    case "contracts":
                      return { text: String(row.contractsCount), value: row.contractsCount, color: colors.textDim };
                    case "turnover":
                      return { text: fmtHkd(row.turnoverHkd), value: row.turnoverHkd, color: colors.textDim };
                    case "issuer":
                      return { text: row.topIssuer ?? MISSING_VALUE, color: colors.textDim };
                    default:
                      return {
                        text: row.isHeavyZone ? (isBull ? "HEAVY BULL" : "HEAVY BEAR") : "",
                        color: sideColor,
                        attributes: row.isHeavyZone ? TextAttributes.BOLD : undefined,
                      };
                  }
                }}
              />
            ) : (
              <DataTableView<HkCbbcContractRow>
                focused={focused}
                rootWidth={width}
                columns={contractCols}
                items={contractRows}
                sortColumnId="equiv"
                sortDirection="desc"
                emptyStateTitle="No active CBBC contracts."
                getItemKey={(row) => row.cbbcCode}
                selection={{
                  kind: "id",
                  selectedId,
                  getId: (r) => r.cbbcCode,
                  onChange: setSelectedId,
                }}
                onRootKeyDown={(key) => handleRefreshKey(key, activeRes.reload, { stopPropagation: true })}
                renderCell={(row, col): DataTableCell => {
                  const isBull = row.direction === "bull";
                  const sideColor = isBull ? colors.positive : colors.negative;
                  switch (col.id) {
                    case "code":
                      return { text: row.cbbcCode, color: colors.textBright, attributes: TextAttributes.BOLD };
                    case "side":
                      return { text: isBull ? "BULL" : "BEAR", color: sideColor };
                    case "call":
                      return { text: fmtCbbcLevel(row.callLevel, summary.isIndex), value: row.callLevel, color: sideColor };
                    case "strike":
                      return { text: fmtCbbcLevel(row.strikeLevel, summary.isIndex), value: row.strikeLevel, color: colors.textDim };
                    case "outPct":
                      return { text: `${formatNumber(row.outInMarketPct, 1)}%`, value: row.outInMarketPct, color: colors.text };
                    case "equiv":
                      return {
                        text: fmtCbbcEquiv(row.equivFutures ?? row.equivUnits, summary.isIndex),
                        value: row.equivFutures ?? row.equivUnits,
                        color: colors.textBright,
                      };
                    case "issuer":
                      return { text: row.issuerName, color: colors.textDim };
                    default:
                      return dayCell(row.maturityDate);
                  }
                }}
              />
            )}
          </Box>
        ) : null}
      </PaneStatusBody>
    </Box>
  );
}
