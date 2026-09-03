import { Box, Text, TextAttributes } from "../../../ui";
import {
  DataTableView,
  StaticChartSurface,
  loadingText,
  unavailableText,
} from "../../../components";
import type { StaticChartSurfaceProps } from "../../../components/chart/static";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { colors, priceColor } from "../../../theme/colors";
import { formatCompact, formatPercentRaw } from "../../../utils/format";
import { formatSignedCompact, formatWeight, renderBar } from "./display";
import type {
  SectorSortPreference,
  SectorTableColumn,
  SectorTableRow,
} from "./sector-model";

export interface AnalyticsMetricRow {
  id: string;
  label: string;
  value: string;
  detail?: string;
  color?: string;
}

export function AnalyticsMetricsPanel({
  summaryRows,
  riskRows,
  height,
}: {
  summaryRows: AnalyticsMetricRow[];
  riskRows: AnalyticsMetricRow[];
  height: number;
}) {
  return (
    <Box flexDirection="column" height={height} paddingX={1} paddingTop={1}>
      <Box height={1}>
        <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
          Summary
        </Text>
      </Box>
      {summaryRows.map((row) => (
        <MetricLine key={row.id} row={row} />
      ))}

      <Box height={1} />
      <Box height={1}>
        <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
          Risk / Return
        </Text>
      </Box>
      {riskRows.map((row) => (
        <MetricLine key={row.id} row={row} />
      ))}
      <Box height={1} />
    </Box>
  );
}

function MetricLine({ row }: { row: AnalyticsMetricRow }) {
  return (
    <Box flexDirection="row" height={1}>
      <Box width={14} flexShrink={0}>
        <Text fg={colors.textDim}>{row.label}</Text>
      </Box>
      <Text fg={row.color ?? colors.text} attributes={TextAttributes.BOLD}>
        {row.value}
      </Text>
      {row.detail && <Text fg={colors.textDim}>{`  ${row.detail}`}</Text>}
    </Box>
  );
}

export function PortfolioHistorySection({
  show,
  loading,
  error,
  width,
  height,
  points,
  palette,
  axisLabel,
  period,
  stale,
  formatAxisValue,
}: {
  show: boolean;
  loading: boolean;
  error: string | null | undefined;
  width: number;
  height: number;
  points: ProjectedChartPoint[];
  palette: StaticChartSurfaceProps["colors"];
  axisLabel: string;
  period: string | undefined;
  stale: boolean | undefined;
  formatAxisValue: (value: number) => string;
}) {
  if (show) {
    return (
      <>
        <Box height={1} paddingX={1} flexDirection="row">
          <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
            Portfolio History
          </Text>
          <Text fg={colors.textDim}>
            {`  Flex ${period ?? ""}${stale ? " - cached" : ""}`}
          </Text>
        </Box>
        <Box paddingX={1} height={height}>
          <StaticChartSurface
            points={points}
            width={Math.max(10, width - 2)}
            height={height}
            mode="line"
            colors={palette}
            yAxisLabel={axisLabel}
            yAxisColor={colors.textDim}
            formatYAxisValue={formatAxisValue}
          />
        </Box>
      </>
    );
  }

  if (loading) {
    return (
      <Box height={1} paddingX={1}>
        <Text fg={colors.textDim}>{loadingText("IBKR history")}</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box height={1} paddingX={1} overflow="hidden">
        <Text fg={colors.warning}>{`${unavailableText("IBKR history")} ${error}`}</Text>
      </Box>
    );
  }

  return null;
}

export function SectorAllocationTable({
  focused,
  resetScrollKey,
  columns,
  rows,
  sort,
  selectedSectorId,
  onHeaderClick,
  onSelectSector,
}: {
  focused: boolean;
  resetScrollKey: string;
  columns: SectorTableColumn[];
  rows: SectorTableRow[];
  sort: SectorSortPreference;
  selectedSectorId: string | null;
  onHeaderClick: (columnId: string) => void;
  onSelectSector: (sectorId: string) => void;
}) {
  return (
    <DataTableView<SectorTableRow, SectorTableColumn>
      focused={focused}
      selection={{
        kind: "id",
        selectedId: selectedSectorId,
        getId: (row) => row.id,
        onChange: (id) => onSelectSector(id),
      }}
      resetScrollKey={resetScrollKey}
      columns={columns}
      items={rows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={onHeaderClick}
      getItemKey={(row) => row.id}
      emptyStateTitle="No sector data available"
      emptyStateHint="Load profile data or add sectors to the portfolio positions."
      renderCell={(row, column) => {
        switch (column.id) {
          case "sector":
            return { text: row.sector };
          case "weight":
            return { text: formatWeight(row.weight) };
          case "value":
            return { text: formatCompact(row.value) };
          case "pnl":
            return {
              text: formatSignedCompact(row.pnl),
              color: priceColor(row.pnl),
            };
          case "return":
            return {
              text: row.returnPct == null ? "—" : formatPercentRaw(row.returnPct),
              color: row.returnPct == null ? colors.textMuted : priceColor(row.returnPct),
            };
          case "bar":
            return {
              text: renderBar(row.weight, column.width),
              color: colors.textMuted,
            };
        }
      }}
    />
  );
}
