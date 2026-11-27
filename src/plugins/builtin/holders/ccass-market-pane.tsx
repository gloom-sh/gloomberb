import { dayCell } from "../../../components/ui/day-cell";
import { useCallback, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import {
  HK_CCASS_BUCKET_SHORT,
  type HkCcassBigChangeRow,
  type HkCcassConcentrationRow,
  type HkCcassParticipantHoldingRow,
  type HkCcassSouthboundRow,
} from "../../../api-client/hk-ccass";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  usePaneFooter,
  usePaneTabs,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
import { handleRefreshKey, loadingErrorFooterInfo } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes, useUiCapabilities } from "../../../ui";
import { MISSING_VALUE, formatCompact, formatNumber } from "../../../utils/format";
import { usePluginAppActions } from "../../runtime";
import { useCommandTab, useCommandValue } from "../shared/command-tab";

export const CCASS_MARKET_PANE_ID = "ccass-market";
export const CCASS_MARKET_TEMPLATE_ID = "ccass-market-pane";

type MarketTab = "changes" | "deposits" | "concentration" | "southbound" | "broker";
const MARKET_TABS: Array<{ label: string; value: MarketTab }> = [
  { label: "Big Changes", value: "changes" },
  { label: "Deposits", value: "deposits" },
  { label: "Concentration", value: "concentration" },
  { label: "Southbound", value: "southbound" },
  { label: "Broker", value: "broker" },
];
const TAB_IDS: readonly MarketTab[] = ["changes", "deposits", "concentration", "southbound", "broker"];

const fmtPct = (v: number | null | undefined) => (v == null ? MISSING_VALUE : `${formatNumber(v, 2)}%`);
const fmtSignedPct = (v: number | null | undefined) =>
  v == null ? MISSING_VALUE : `${v > 0 ? "+" : ""}${formatNumber(v, 2)}%`;
const fmtSignedCompact = (v: number | null | undefined) =>
  v == null ? MISSING_VALUE : v === 0 ? "0" : `${v > 0 ? "+" : "-"}${formatCompact(Math.abs(v))}`;
const signColor = (v: number | null | undefined) =>
  v == null || v === 0 ? colors.textDim : v > 0 ? colors.positive : colors.negative;

export function CcassMarketPane({ width, height, focused }: Pick<PaneProps, "width" | "height" | "focused">) {
  const { nativePaneChrome } = useUiCapabilities();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [activeTab, setActiveTab] = useCommandTab<MarketTab>(
    CCASS_MARKET_PANE_ID,
    "ccassMarket:tab",
    TAB_IDS,
    "changes",
  );
  const [brokerId, setBrokerId] = useCommandValue<string>(
    CCASS_MARKET_PANE_ID,
    "ccassMarket:partId",
    (params) => params.partId?.trim().toUpperCase() || null,
    "B01955",
  );
  const [brokerDraft, setBrokerDraft] = useState(brokerId);
  const [brokerInputActive, setBrokerInputActive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const openStockCcass = useCallback((symbol: string) => {
    createPaneFromTemplate("ccass-pane", { symbol });
  }, [createPaneFromTemplate]);

  const loadChanges = useCallback(
    () => apiClient.getHkCcassBigChanges({ depositsOnly: activeTab === "deposits", limit: 150 }),
    [activeTab],
  );
  const loadConcentration = useCallback(
    () => apiClient.getHkCcassConcentration({ sortBy: "top10", limit: 150 }),
    [],
  );
  const loadSouthbound = useCallback(
    () => apiClient.getHkCcassSouthbound({ sortBy: "pct", limit: 150 }),
    [],
  );
  const loadBroker = useCallback(
    () => apiClient.getHkCcassParticipant(brokerId || "B01955", { sortBy: "pct", limit: 150 }),
    [brokerId],
  );

  const changesRes = useAsyncResource(activeTab === "changes" || activeTab === "deposits" ? loadChanges : null);
  const concRes = useAsyncResource(activeTab === "concentration" ? loadConcentration : null);
  const sbRes = useAsyncResource(activeTab === "southbound" ? loadSouthbound : null);
  const brokerRes = useAsyncResource(activeTab === "broker" ? loadBroker : null);

  const activeRes =
    activeTab === "concentration"
      ? concRes
      : activeTab === "southbound"
        ? sbRes
        : activeTab === "broker"
          ? brokerRes
          : changesRes;

  const { strip: tabStrip } = usePaneTabs({
    tabs: MARKET_TABS,
    activeValue: activeTab,
    onSelect: (value) => setActiveTab(value as MarketTab),
    focused: focused && !brokerInputActive,
    compact: true,
    variant: "bare",
    queryBarWidth: width,
  });

  usePaneFooter("ccass-market", () => ({
    info: [
      {
        id: "ccass-market-info",
        parts: [{
          text: activeTab === "broker" && brokerRes.data
            ? `${brokerRes.data.participant.partId} ${brokerRes.data.participant.name} · ${brokerRes.data.participant.positionsCount} positions`
            : "HKEX CCASS · Historical archive: Webb-site (CC BY 4.0)",
          tone: "muted" as const,
        }],
      },
      ...loadingErrorFooterInfo(activeRes.loading, activeRes.data ? activeRes.error : null),
    ],
    hints: [{ id: "open", key: "Enter", label: "open CCASS" }],
  }), [activeRes.data, activeRes.error, activeRes.loading, activeTab, brokerRes.data]);

  const changeColumns: DataTableColumn[] = useMemo(() => {
    const fixed = 11 + 9 + 9 + 8 + 10;
    const stockW = Math.max(14, Math.floor((width - 8 - fixed) * 0.42));
    const partW = Math.max(16, width - 8 - fixed - stockW);
    return [
      { id: "date", label: "DATE", width: 11, align: "left" },
      { id: "symbol", label: "CODE", width: 9, align: "left" },
      { id: "stock", label: "STOCK", width: stockW, align: "left" },
      { id: "participant", label: "PARTICIPANT", width: partW, align: "left" },
      { id: "type", label: "TYPE", width: 9, align: "left" },
      { id: "deltaPct", label: "CHG%", width: 8, align: "right" },
      { id: "deltaShares", label: "SHARES Δ", width: 10, align: "right" },
    ];
  }, [width]);

  const concColumns: DataTableColumn[] = useMemo(() => {
    const fixed = 9 + 8 + 8 + 9 + 8 + 8 + 6;
    const stockW = Math.max(18, width - 8 - fixed);
    return [
      { id: "symbol", label: "CODE", width: 9, align: "left" },
      { id: "stock", label: "STOCK", width: stockW, align: "left" },
      { id: "top10Pct", label: "TOP10%", width: 8, align: "right" },
      { id: "top5Pct", label: "TOP5%", width: 8, align: "right" },
      { id: "top10Non", label: "+NON-CC", width: 9, align: "right" },
      { id: "ccassPct", label: "CCASS%", width: 8, align: "right" },
      { id: "sbPct", label: "SB%", width: 8, align: "right" },
      { id: "parts", label: "PARTS", width: 6, align: "right" },
    ];
  }, [width]);

  const sbColumns: DataTableColumn[] = useMemo(() => {
    const fixed = 9 + 9 + 9 + 10 + 10 + 8;
    const stockW = Math.max(18, width - 8 - fixed);
    return [
      { id: "symbol", label: "CODE", width: 9, align: "left" },
      { id: "stock", label: "STOCK", width: stockW, align: "left" },
      { id: "sbPct", label: "SB%", width: 9, align: "right" },
      { id: "deltaPct", label: "1D%", width: 9, align: "right" },
      { id: "deltaShares", label: "1D SH", width: 10, align: "right" },
      { id: "shares", label: "SB SH", width: 10, align: "right" },
      { id: "ccassPct", label: "CCASS%", width: 8, align: "right" },
    ];
  }, [width]);

  const brokerColumns: DataTableColumn[] = useMemo(() => {
    const fixed = 9 + 8 + 10 + 10 + 8 + 11;
    const stockW = Math.max(18, width - 8 - fixed);
    return [
      { id: "symbol", label: "CODE", width: 9, align: "left" },
      { id: "stock", label: "STOCK", width: stockW, align: "left" },
      { id: "pct", label: "HELD%", width: 8, align: "right" },
      { id: "shares", label: "SHARES", width: 10, align: "right" },
      { id: "deltaShares", label: "1D SH", width: 10, align: "right" },
      { id: "deltaPct", label: "1D%", width: 8, align: "right" },
      { id: "changed", label: "CHANGED", width: 11, align: "right" },
    ];
  }, [width]);

  type MarketRow = HkCcassBigChangeRow | HkCcassConcentrationRow | HkCcassSouthboundRow | HkCcassParticipantHoldingRow;
  const tableConfig: {
    focused: boolean;
    items: readonly MarketRow[];
    columns: DataTableColumn[];
    getId: (row: MarketRow) => string;
    resetScrollKey: string;
    onReload: () => void;
    emptyStateTitle: string;
    renderCell: (row: MarketRow, col: DataTableColumn) => DataTableCell;
  } = activeTab === "changes" || activeTab === "deposits"
    ? {
      focused,
      items: changesRes.data?.rows ?? [],
      columns: changeColumns,
      getId: (row) => {
        const r = row as HkCcassBigChangeRow;
        return `${r.date}:${r.code}:${r.partId}`;
      },
      resetScrollKey: activeTab,
      onReload: changesRes.reload,
      emptyStateTitle: activeTab === "deposits" ? "No pre-placement deposits recorded." : "No CCASS big changes recorded.",
      renderCell: (row, col) => {
        const r = row as HkCcassBigChangeRow;
        switch (col.id) {
          case "date": return { ...dayCell(r.date), color: colors.textDim };
          case "participant": return { text: r.participantName, color: colors.textMuted };
          case "type": return {
            text: r.isDeposit ? "DEPOSIT" : r.isWithdrawal ? "WITHDRAW" : "TRANSFER",
            color: r.isDeposit ? colors.warning : r.isWithdrawal ? colors.borderFocused : colors.textDim,
          };
          case "deltaPct": return { text: fmtSignedPct(r.deltaPct), color: signColor(r.deltaPct) };
          case "deltaShares": return { text: fmtSignedCompact(r.deltaShares), color: signColor(r.deltaShares) };
          default: return { text: MISSING_VALUE };
        }
      },
    }
    : activeTab === "concentration"
      ? {
        focused,
        items: concRes.data?.rows ?? [],
        columns: concColumns,
        getId: (row) => row.code,
        resetScrollKey: "concentration",
        onReload: concRes.reload,
        emptyStateTitle: "No concentration rankings available.",
        renderCell: (row, col) => {
          const r = row as HkCcassConcentrationRow;
          switch (col.id) {
            case "top10Pct": return { text: fmtPct(r.top10Pct), color: colors.textBright };
            case "top5Pct": return { text: fmtPct(r.top5Pct), color: colors.text };
            case "top10Non": return { text: fmtPct(r.top10PlusNonCcassPct), color: colors.textMuted };
            case "ccassPct": return { text: fmtPct(r.ccassPct), color: colors.textDim };
            case "sbPct": return { text: fmtPct(r.southboundPct), color: colors.textMuted };
            case "parts": return { text: String(r.participants), color: colors.textDim };
            default: return { text: MISSING_VALUE };
          }
        },
      }
      : activeTab === "southbound"
        ? {
          focused,
          items: sbRes.data?.rows ?? [],
          columns: sbColumns,
          getId: (row) => row.code,
          resetScrollKey: "southbound",
          onReload: sbRes.reload,
          emptyStateTitle: "No Southbound holdings available.",
          renderCell: (row, col) => {
            const r = row as HkCcassSouthboundRow;
            switch (col.id) {
              case "sbPct": return { text: fmtPct(r.southboundPct), color: colors.textBright };
              case "deltaPct": return { text: fmtSignedPct(r.deltaPct), color: signColor(r.deltaPct) };
              case "deltaShares": return { text: fmtSignedCompact(r.deltaShares), color: signColor(r.deltaShares) };
              case "shares": return { text: formatCompact(r.southboundShares), color: colors.text };
              case "ccassPct": return { text: fmtPct(r.ccassPct), color: colors.textDim };
              default: return { text: MISSING_VALUE };
            }
          },
        }
        : {
          focused: focused && !brokerInputActive,
          items: brokerRes.data?.holdings ?? [],
          columns: brokerColumns,
          getId: (row) => row.code,
          resetScrollKey: `broker:${brokerId}`,
          onReload: brokerRes.reload,
          emptyStateTitle: `No CCASS positions found for ${brokerId}.`,
          renderCell: (row, col) => {
            const r = row as HkCcassParticipantHoldingRow;
            switch (col.id) {
              case "pct": return { text: fmtPct(r.pct), color: colors.textBright };
              case "shares": return { text: formatCompact(r.shares), color: colors.text };
              case "deltaShares": return { text: fmtSignedCompact(r.deltaShares), color: signColor(r.deltaShares) };
              case "deltaPct": return { text: fmtSignedPct(r.deltaPct), color: signColor(r.deltaPct) };
              case "changed": return { ...dayCell(r.lastChanged), color: colors.textDim };
              default: return { text: MISSING_VALUE };
            }
          },
        };

  return (
    <Box flexDirection="column" width={width} height={height}>
      {nativePaneChrome ? tabStrip : tabStrip && <Box height={1} paddingX={1}>{tabStrip}</Box>}

      {activeTab === "broker" ? (
        <QueryBar
          width={width}
          filters={[
            {
              id: "partId",
              kind: "text",
              label: "CCASS ID",
              value: brokerDraft,
              placeholder: "B01955",
              width: 12,
              focused,
              active: brokerInputActive,
              onActiveChange: setBrokerInputActive,
              onChange: setBrokerDraft,
              onSubmit: (val) => {
                const next = val.trim().toUpperCase();
                if (next) setBrokerId(next);
              },
            },
          ]}
          meta={brokerRes.data ? HK_CCASS_BUCKET_SHORT[brokerRes.data.participant.bucket] : "e.g. B01955, A00003, C00019"}
        />
      ) : null}

      <PaneStatusBody
        loading={activeRes.loading && !activeRes.data}
        error={activeRes.data ? null : activeRes.error}
        subject="Hong Kong CCASS market data"
        empty={false}
      >
        <DataTableView<MarketRow, DataTableColumn>
          focused={tableConfig.focused}
          rootWidth={width}
          items={[...tableConfig.items]}
          columns={tableConfig.columns}
          sortColumnId={null}
          sortDirection="desc"
          selection={{
            kind: "id",
            selectedId,
            getId: tableConfig.getId,
            onChange: setSelectedId,
          }}
          getItemKey={tableConfig.getId}
          resetScrollKey={tableConfig.resetScrollKey}
          onActivate={(row) => openStockCcass(row.symbol)}
          onRootKeyDown={(event) => handleRefreshKey(event, tableConfig.onReload, { stopPropagation: true })}
          selectedTextOverridesCellColor
          emptyStateTitle={tableConfig.emptyStateTitle}
          renderCell={(row, col): DataTableCell => {
            if (col.id === "symbol") return { text: row.symbol, color: colors.textBright, attributes: TextAttributes.BOLD };
            if (col.id === "stock") return { text: row.stockName || row.stockNameZh || row.symbol, color: colors.text };
            return tableConfig.renderCell(row, col);
          }}
        />
      </PaneStatusBody>
    </Box>
  );
}
