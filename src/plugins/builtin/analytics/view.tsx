import {
  DataTableView, KeyValueRow, Notice, SectionHeading, Spinner, StaticChartSurface,
  loadingText,
  unavailableText
} from "../../../components";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import type { StaticChartSurfaceProps } from "../../../components/chart/static";
import { colors, priceColor } from "../../../theme/colors";
import { Box, Text } from "../../../ui";
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
      <SectionHeading title="Summary" />
      {summaryRows.map((row) => (
        <KeyValueRow key={row.id} {...row} />
      ))}

      <Box height={1} />
      <SectionHeading title="Current-weight basket estimates" />
      {riskRows.map((row) => (
        <KeyValueRow key={row.id} {...row} labelWidth={16} />
      ))}
      <Box height={1} />
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
  note,
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
  note: string | null;
  formatAxisValue: (value: number) => string;
}) {
  if (show) {
    return (
      <>
        <Box height={1} paddingX={1} flexDirection="row">
          <SectionHeading title="Portfolio History" />
          <Text fg={colors.textDim}>
            {`  Flex ${period ?? ""}${stale ? " - cached" : ""}`}
          </Text>
        </Box>
        {note ? <Box paddingX={1} flexDirection="column" flexShrink={0}><Notice tone="muted">{note}</Notice></Box> : null}
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
        <Spinner label={loadingText("account history")} />
      </Box>
    );
  }

  if (error) {
    return (
      <Box paddingX={1} flexDirection="column" flexShrink={0}>
        <Notice>{`${unavailableText("Account history")} ${error}`}</Notice>
      </Box>
    );
  }

  if (points.length > 0) {
    return (
      <Box paddingX={1} flexDirection="column" flexShrink={0}>
        <Notice tone="muted">{`${points.length >= 2 ? "Enlarge this pane to view account history." : "Account history needs at least two observations for a chart."}${note ? ` ${note}` : ""}`}</Notice>
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
            return { text: row.value == null ? "—" : formatCompact(row.value) };
          case "pnl":
            return {
              text: formatSignedCompact(row.pnl),
              color: row.pnl == null ? colors.textMuted : priceColor(row.pnl),
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
