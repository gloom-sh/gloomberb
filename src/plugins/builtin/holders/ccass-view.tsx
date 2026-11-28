import { dayCell } from "../../../components/ui/day-cell";
import { useCallback, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import {
  HK_CCASS_BUCKET_SHORT,
  type HkCcassBucket,
  type HkCcassHoldingRow,
} from "../../../api-client/hk-ccass";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  StatGrid,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type StatItem,
} from "../../../components";
import { handleRefreshKey, loadingErrorFooterInfo } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { colors } from "../../../theme/colors";
import { Box, TextAttributes } from "../../../ui";
import { MISSING_VALUE, formatCompact, formatNumber } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { compareSortValues, nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { usePluginAppActions } from "../../runtime";
import { CCASS_MARKET_TEMPLATE_ID } from "./ccass-market-pane";

type DiffWindow = "1d" | "5d" | "30d";
type CcassSortId = "partId" | "name" | "bucket" | "shares" | "pct" | "deltaShares" | "deltaPct" | "lastChanged";

const WINDOW_OPTIONS: readonly { value: DiffWindow; label: string }[] = [
  { value: "1d", label: "1D" },
  { value: "5d", label: "5D" },
  { value: "30d", label: "30D" },
];

const BUCKET_OPTIONS: readonly { value: HkCcassBucket | "all"; label: string }[] = [
  { value: "all", label: "All groups" },
  { value: "southbound", label: "Southbound" },
  { value: "foreign_custodian", label: "Custodians" },
  { value: "foreign_broker", label: "Global PBs" },
  { value: "chinese_broker", label: "CN Brokers" },
  { value: "retail_broker", label: "Retail" },
];

function dateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function fmtPct(value: number | null | undefined, digits = 2): string {
  return value == null ? MISSING_VALUE : `${formatNumber(value, digits)}%`;
}

function fmtSignedPct(value: number | null | undefined): string {
  if (value == null) return MISSING_VALUE;
  if (value === 0) return "0.00%";
  return `${value > 0 ? "+" : ""}${formatNumber(value, 2)}%`;
}

function fmtSignedCompact(value: number | null | undefined): string {
  if (value == null) return MISSING_VALUE;
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "-"}${formatCompact(Math.abs(value))}`;
}

function deltaColor(value: number | null | undefined): string {
  if (value == null || value === 0) return colors.textDim;
  return value > 0 ? colors.positive : colors.negative;
}

export function CcassStockView({
  code,
  viaAdr,
  focused,
  width,
  onCycle,
}: {
  code: string;
  viaAdr: string | null;
  focused: boolean;
  width: number;
  onCycle: () => void;
}) {
  const { createPaneFromTemplate } = usePluginAppActions();
  const [windowMode, setWindowMode] = useState<DiffWindow>("1d");
  const [bucketFilter, setBucketFilter] = useState<HkCcassBucket | "all">("all");
  const [sort, setSort] = useState<{ columnId: CcassSortId; direction: SortDirection }>({
    columnId: "shares",
    direction: "desc",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fromParam = useMemo(() => {
    if (windowMode === "5d") return dateDaysAgo(7);
    if (windowMode === "30d") return dateDaysAgo(35);
    return undefined;
  }, [windowMode]);

  const load = useCallback(
    () => apiClient.getHkCcassStock(code, { from: fromParam, limit: 200 }),
    [code, fromParam],
  );
  const { data, loading, error, reload } = useAsyncResource(load);
  const payload = data?.code === code ? data : null;

  const filteredRows = useMemo(() => {
    const base = payload?.holdings ?? [];
    const kept = bucketFilter === "all" ? base : base.filter((row) => row.bucket === bucketFilter);
    return [...kept].sort((left, right) => {
      const valueOf = (row: HkCcassHoldingRow): string | number | null => {
        switch (sort.columnId) {
          case "partId": return row.ccassId ?? row.partId;
          case "name": return row.name;
          case "bucket": return row.bucket;
          case "shares": return row.shares;
          case "pct": return row.pct;
          case "deltaShares": return row.deltaShares;
          case "deltaPct": return row.deltaPct;
          case "lastChanged": return row.lastChanged;
        }
      };
      return compareSortValues(valueOf(left), valueOf(right), sort.direction);
    });
  }, [bucketFilter, payload?.holdings, sort]);

  const selectedRow = useMemo(
    () => filteredRows.find((row) => row.partId === selectedId) ?? filteredRows[0] ?? null,
    [filteredRows, selectedId],
  );

  const openBroker = useCallback((row: HkCcassHoldingRow | null) => {
    if (!row) return;
    createPaneFromTemplate(CCASS_MARKET_TEMPLATE_ID, {
      arg: row.partId,
    });
  }, [createPaneFromTemplate]);

  const openMarketScanner = useCallback(() => {
    createPaneFromTemplate(CCASS_MARKET_TEMPLATE_ID, {
      arg: "changes",
    });
  }, [createPaneFromTemplate]);

  usePaneFooter("holders-ccass", () => ({
    info: [
      {
        id: "ccass-asof",
        parts: [{
          text: payload
            ? [
                `HKEX CCASS ${payload.asOfDate}`,
                viaAdr ? `via ${viaAdr}` : null,
                payload.compareFromDate ? `vs ${payload.compareFromDate}` : null,
                "Archive: Webb-site (CC BY 4.0)",
              ].filter(Boolean).join(" · ")
            : "HKEX CCASS",
          tone: "muted" as const,
        }],
      },
      ...loadingErrorFooterInfo(loading, payload ? error : null),
    ],
    hints: [
      ...(selectedRow ? [{ id: "broker", key: "o", label: "pen broker", onPress: () => openBroker(selectedRow) }] : []),
      { id: "market", key: "m", label: "arket scanner", onPress: openMarketScanner },
    ],
  }), [error, loading, openBroker, openMarketScanner, payload, selectedRow, viaAdr]);

  const stats: StatItem[] = useMemo(() => {
    if (!payload) return [];
    const deltaTone = (payload.ccassDeltaShares ?? 0) > 0
      ? "warning"
      : (payload.ccassDeltaShares ?? 0) < 0
        ? "accent"
        : "neutral";
    return [
      {
        id: "in-ccass",
        essential: true,
        label: "In CCASS",
        value: fmtPct(payload.ccassPct),
        detail: `${formatCompact(payload.ccassShares)} sh`,
      },
      {
        id: "outside",
        label: "Outside CCASS",
        value: fmtPct(payload.outsideCcassPct),
        detail: payload.outsideCcassShares != null ? `${formatCompact(payload.outsideCcassShares)} sh` : undefined,
      },
      {
        id: "conc",
        essential: true,
        label: "Top 10 / Top 5",
        value: fmtPct(payload.top10Pct),
        detail: `Top 5 ${fmtPct(payload.top5Pct)}`,
      },
      {
        id: "southbound",
        essential: true,
        label: "Southbound",
        value: fmtPct(payload.southboundPct),
        detail: `${formatCompact(payload.southboundShares)} sh`,
      },
      {
        id: "net-delta",
        label: "Net CCASS Δ",
        value: fmtSignedPct(payload.ccassDeltaPct),
        detail: fmtSignedCompact(payload.ccassDeltaShares),
        tone: deltaTone,
      },
    ];
  }, [payload]);

  const columns: Array<DataTableColumn & { id: CcassSortId }> = useMemo(() => {
    const idWidth = 8;
    const groupWidth = 11;
    const sharesWidth = 10;
    const pctWidth = 8;
    const deltaWidth = 10;
    const deltaPctWidth = 8;
    const dateWidth = 11;
    const fixed = idWidth + groupWidth + sharesWidth + pctWidth + deltaWidth + deltaPctWidth + dateWidth;
    const nameWidth = Math.max(18, width - 10 - fixed);
    return [
      { id: "partId", label: "ID", width: idWidth, align: "left" },
      { id: "name", label: "PARTICIPANT", width: nameWidth, align: "left" },
      { id: "bucket", label: "GROUP", width: groupWidth, align: "left" },
      { id: "shares", label: "SHARES", width: sharesWidth, align: "right" },
      { id: "pct", label: "HELD%", width: pctWidth, align: "right" },
      { id: "deltaShares", label: "CHG", width: deltaWidth, align: "right" },
      { id: "deltaPct", label: "CHG%", width: deltaPctWidth, align: "right" },
      { id: "lastChanged", label: "CHANGED", width: dateWidth, align: "right" },
    ];
  }, [width]);

  const renderCell = useCallback(
    (row: HkCcassHoldingRow, column: DataTableColumn & { id: CcassSortId }): DataTableCell => {
      switch (column.id) {
        case "partId":
          return { text: row.ccassId ?? "CIP", color: colors.textDim };
        case "name":
          return { text: row.name, color: colors.textBright, attributes: TextAttributes.BOLD };
        case "bucket":
          return { text: HK_CCASS_BUCKET_SHORT[row.bucket], color: colors.textMuted };
        case "shares":
          return { text: formatCompact(row.shares), color: colors.text };
        case "pct":
          return { text: fmtPct(row.pct), color: colors.textBright };
        case "deltaShares":
          return { text: fmtSignedCompact(row.deltaShares), color: deltaColor(row.deltaShares) };
        case "deltaPct":
          return { text: fmtSignedPct(row.deltaPct), color: deltaColor(row.deltaPct) };
        case "lastChanged":
          return { ...dayCell(row.lastChanged), color: colors.textDim };
      }
    },
    [],
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <QueryBar
        width={width}
        filters={[
          {
            id: "bucket",
            kind: "select",
            label: "Group",
            value: bucketFilter,
            options: BUCKET_OPTIONS,
            onChange: setBucketFilter,
          },
        ]}
        view={{
          label: "Window",
          value: windowMode,
          options: WINDOW_OPTIONS,
          onChange: setWindowMode,
          focused,
        }}
        asOf={payload?.asOfDate}
      />

      <PaneStatusBody
        loading={loading && !payload}
        error={payload ? null : error}
        subject="Hong Kong CCASS custody"
        empty={!!payload && filteredRows.length === 0}
        emptyTitle="No CCASS participant holdings match this filter."
      >
        {stats.length > 0 ? <StatGrid items={stats} width={width} columns={Math.min(5, Math.max(2, Math.floor(width / 22)))} /> : null}
        <DataTableView<HkCcassHoldingRow, DataTableColumn & { id: CcassSortId }>
          focused={focused}
          rootWidth={width}
          items={filteredRows}
          columns={columns}
          sortColumnId={sort.columnId}
          sortDirection={sort.direction}
          onHeaderClick={(columnId) => setSort((prev) => nextHeaderSort(prev, columnId as CcassSortId))}
          selection={{
            kind: "id",
            selectedId: selectedRow?.partId ?? null,
            getId: (row) => row.partId,
            onChange: setSelectedId,
          }}
          getItemKey={(row) => row.partId}
          resetScrollKey={`${code}:${windowMode}:${bucketFilter}`}
          onActivate={(row) => openBroker(row)}
          onRootKeyDown={(event) => {
            if (handleRefreshKey(event, reload, { stopPropagation: true })) return true;
            if (isPlainKey(event, "s")) { onCycle(); return true; }
            if (isPlainKey(event, "o") && selectedRow) { openBroker(selectedRow); return true; }
            if (isPlainKey(event, "m")) { openMarketScanner(); return true; }
            return false;
          }}
          renderCell={renderCell}
          selectedTextOverridesCellColor
          emptyStateTitle="No CCASS participant holdings."
        />
      </PaneStatusBody>
    </Box>
  );
}
