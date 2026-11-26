import { useCallback, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import type {
  DilutionForm144Row,
  DilutionOfferingRow,
  DilutionShelfRow,
} from "../../../api-client/dilution";
import {
  DataTableView,
  Notice,
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
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, useRendererHost } from "../../../ui";
import { MISSING_VALUE } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { logFailure } from "../../../utils/log-failure";
import { usePluginAppActions } from "../../runtime";
import { useCommandTab } from "../shared/command-tab";
import {
  buildCapacityBar,
  DILUTION_TAB_IDS,
  DILUTION_TABS,
  fmtPct,
  fmtShares,
  fmtUsd,
  form144Columns,
  offeringColumns,
  offeringTypeShort,
  riskTierLabel,
  scannerShelfColumns,
  shelfCapacitySummary,
  shelfColumns,
  type DilutionTab,
} from "./model";

export const DILUTION_PANE_ID = "equity-dilution";
export const DILUTION_TEMPLATE_ID = "equity-dilution-pane";

type ScannerMode = "form144" | "shelves" | "atm";

const SCANNER_OPTIONS: readonly { value: ScannerMode; label: string }[] = [
  { value: "form144", label: "Form 144 Feed" },
  { value: "atm", label: "Active ATMs" },
  { value: "shelves", label: "All Active Shelves" },
];

const F144_FILTER_OPTIONS: readonly { value: "all" | "plan"; label: string }[] = [
  { value: "all", label: "All Notices" },
  { value: "plan", label: "Rule 10b5-1" },
];

export function DilutionPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const { symbol } = usePaneTickerIdentity();
  const { createPaneFromTemplate } = usePluginAppActions();

  const defaultTab: DilutionTab = symbol ? "overview" : "scanner";
  const [activeTab, setActiveTab] = useCommandTab<DilutionTab>(
    DILUTION_PANE_ID,
    "dilution:tab",
    DILUTION_TAB_IDS,
    defaultTab,
  );
  const [scannerMode, setScannerMode] = useState<ScannerMode>("form144");
  const [planFilter, setPlanFilter] = useState<"all" | "plan">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadCompany = useCallback(
    () => apiClient.getDilutionCompany(symbol!),
    [symbol],
  );
  const loadScanner144 = useCallback(
    () => apiClient.getDilutionForm144({ plan10b51Only: planFilter === "plan", limit: 100 }),
    [planFilter],
  );
  const loadScannerShelves = useCallback(
    () => apiClient.getDilutionShelves({ atmOnly: scannerMode === "atm", limit: 100 }),
    [scannerMode],
  );

  const companyRes = useAsyncResource(
    symbol && activeTab !== "scanner" ? loadCompany : null,
  );
  const scan144Res = useAsyncResource(
    activeTab === "scanner" && scannerMode === "form144" ? loadScanner144 : null,
  );
  const scanShelvesRes = useAsyncResource(
    activeTab === "scanner" && scannerMode !== "form144" ? loadScannerShelves : null,
  );

  const activeRes =
    activeTab === "scanner"
      ? scannerMode === "form144"
        ? scan144Res
        : scanShelvesRes
      : companyRes;

  const company = companyRes.data;
  const metrics = company?.metrics ?? null;

  const { strip: tabStrip } = usePaneTabs({
    tabs: [...DILUTION_TABS],
    activeValue: activeTab,
    onSelect: (value) => {
      setActiveTab(value as DilutionTab);
      setSelectedId(null);
    },
    focused,
    dense: true,
  });

  const filteredCompany144 = useMemo(() => {
    const base = company?.form144 ?? [];
    return planFilter === "plan" ? base.filter((r) => r.plan10b51Date != null) : base;
  }, [company?.form144, planFilter]);

  const selectedSourceUrl = useMemo(() => {
    if (activeTab === "overview") {
      const row = company?.shelves.find((s) => s.accession === selectedId) ?? company?.shelves[0];
      return row?.sourceUrl ?? null;
    }
    if (activeTab === "offerings") {
      const row = company?.offerings.find((o) => o.accession === selectedId) ?? company?.offerings[0];
      return row?.sourceUrl ?? null;
    }
    if (activeTab === "form144") {
      const row = filteredCompany144.find((f) => f.accession === selectedId) ?? filteredCompany144[0];
      return row?.sourceUrl ?? null;
    }
    if (scannerMode === "form144") {
      const row = scan144Res.data?.rows.find((f) => f.accession === selectedId) ?? scan144Res.data?.rows[0];
      return row?.sourceUrl ?? null;
    }
    const row = scanShelvesRes.data?.rows.find((s) => s.accession === selectedId) ?? scanShelvesRes.data?.rows[0];
    return row?.sourceUrl ?? null;
  }, [activeTab, company, filteredCompany144, scan144Res.data, scanShelvesRes.data, scannerMode, selectedId]);

  const openTickerDilution = useCallback(
    (sym: string) => {
      createPaneFromTemplate(DILUTION_TEMPLATE_ID, { symbol: sym });
    },
    [createPaneFromTemplate],
  );

  const openFiling = useCallback(() => {
    if (selectedSourceUrl) {
      void host.openExternal(selectedSourceUrl).catch(logFailure("equity-dilution", "open external filing failed"));
    }
  }, [host, selectedSourceUrl]);

  usePaneFooter(
    DILUTION_PANE_ID,
    () => ({
      info: [
        {
          id: "dilution-status",
          parts: [
            {
              text:
                activeTab === "scanner"
                  ? "SEC EDGAR Dilution & Form 144 Scanner"
                  : company
                    ? `${company.symbol} · ${company.companyName}${company.cik ? ` · CIK ${company.cik}` : ""}`
                    : "Equity Dilution (DILU)",
              tone: "muted" as const,
            },
          ],
        },
        ...loadingErrorFooterInfo(activeRes.loading, activeRes.error),
      ],
      hints: [
        ...(selectedSourceUrl
          ? [{ id: "open-edgar", key: "o", label: "pen filing", onPress: openFiling }]
          : []),
        { id: "refresh", key: "r", label: "efresh", onPress: () => activeRes.reload() },
      ],
    }),
    [activeTab, company, activeRes, selectedSourceUrl, openFiling],
  );

  const handleKey = useCallback(
    (key: Parameters<typeof handleRefreshKey>[0]) => {
      if (handleRefreshKey(key, activeRes.reload, { stopPropagation: true })) return true;
      if (isPlainKey(key, "o") && selectedSourceUrl) {
        openFiling();
        return true;
      }
      return false;
    },
    [activeRes.reload, openFiling, selectedSourceUrl],
  );

  const overviewStats = useMemo<StatItem[]>(() => {
    if (!metrics) return [];
    const tierTone =
      metrics.riskTier === "high"
        ? "negative"
        : metrics.riskTier === "elevated"
          ? "warning"
          : metrics.riskTier === "low"
            ? "positive"
            : undefined;
    return [
      {
        id: "overhang",
        essential: true,
        label: "Overhang",
        value: `${riskTierLabel(metrics.riskTier)}${metrics.overhangPctOfMarketCap != null ? ` (${fmtPct(metrics.overhangPctOfMarketCap, 1)})` : ""}`,
        tone: tierTone,
      },
      {
        id: "shelves",
        essential: true,
        label: "Shelves",
        value: `${metrics.activeShelfCount} active`,
        detail: metrics.hasWksiShelf ? "WKSI S-3ASR" : metrics.babyShelfRestricted ? "I.B.6 1/3 cap" : "S-3",
      },
      {
        id: "atm",
        essential: true,
        label: "ATM Capacity",
        value: metrics.atmCapacityUsd > 0 ? fmtUsd(metrics.atmCapacityUsd) : "None",
        detail: `${metrics.activeAtmCount} prog.`,
        tone: metrics.activeAtmCount > 0 ? "warning" : undefined,
      },
      {
        id: "offerings-12m",
        label: "12m Offered",
        value: fmtUsd(metrics.offerings12mUsd),
        detail: `${metrics.offerings12mCount} filings`,
      },
      {
        id: "form144-90d",
        essential: true,
        label: "Form 144 (90d)",
        value: fmtUsd(metrics.form144Value90dUsd),
        detail: `${metrics.form144Count90d} notices`,
        tone: metrics.form144Value90dUsd > 0 ? "negative" : undefined,
      },
      ...(metrics.nextLockupExpiryDate
        ? [
            {
              id: "lockup",
              label: "Next Lock-Up",
              value: metrics.nextLockupExpiryDate,
              detail: metrics.nextLockupDays != null ? `${metrics.nextLockupDays}d` : undefined,
              tone: (metrics.nextLockupDays ?? 999) <= 45 ? ("negative" as const) : undefined,
            },
          ]
        : metrics.hkDepositCount90d > 0
          ? [
              {
                id: "hk-deposits",
                label: "HK Deposits",
                value: `${metrics.hkDepositCount90d} (max +${fmtPct(metrics.hkDepositMaxPct, 2)})`,
                tone: "warning" as const,
              },
            ]
          : []),
    ];
  }, [metrics]);

  const shelfCols = useMemo(() => shelfColumns(width), [width]);
  const offCols = useMemo(() => offeringColumns(width), [width]);
  const f144Cols = useMemo(
    () => form144Columns(width, activeTab === "scanner"),
    [width, activeTab],
  );
  const scanShelfCols = useMemo(() => scannerShelfColumns(width), [width]);

  const capacityBar = metrics ? buildCapacityBar(metrics) : "";

  return (
    <Box width={width} height={height} flexDirection="column">
      {tabStrip}

      {activeTab === "scanner" ? (
        <Box flexDirection="column" flexGrow={1} minHeight={0}>
          <QueryBar
            width={width}
            filters={[
              {
                id: "mode",
                label: "Feed",
                inline: true,
                value: scannerMode,
                options: [...SCANNER_OPTIONS],
                onChange: (v: string) => {
                  setScannerMode(v as ScannerMode);
                  setSelectedId(null);
                },
              },
              ...(scannerMode === "form144"
                ? [
                    {
                      id: "plan",
                      label: "Plan",
                      inline: true,
                      value: planFilter,
                      options: [...F144_FILTER_OPTIONS],
                      onChange: (v: string) => setPlanFilter(v as "all" | "plan"),
                    },
                  ]
                : []),
            ]}
          />
          <PaneStatusBody
            loading={!activeRes.data && activeRes.loading}
            error={!activeRes.data ? activeRes.error : null}
            empty={
              !activeRes.loading &&
              (scannerMode === "form144"
                ? (scan144Res.data?.rows.length ?? 0) === 0
                : (scanShelvesRes.data?.rows.length ?? 0) === 0)
            }
            emptyTitle="No dilution filings indexed yet."
            subject="equity dilution scanner"
          >
            {scannerMode === "form144" ? (
              <DataTableView<DilutionForm144Row>
                focused={focused}
                rootWidth={width}
                columns={f144Cols}
                items={scan144Res.data?.rows ?? []}
                sortColumnId="filed"
                sortDirection="desc"
                emptyStateTitle="No Form 144 notices found."
                getItemKey={(row) => row.accession}
                selection={{
                  kind: "id",
                  selectedId,
                  getId: (r) => r.accession,
                  onChange: setSelectedId,
                }}
                onActivate={(row) => openTickerDilution(row.symbol)}
                onRootKeyDown={handleKey}
                renderCell={(row, col): DataTableCell => {
                  switch (col.id) {
                    case "filed":
                      return dayCell(row.filingDate);
                    case "symbol":
                      return { text: row.symbol, color: colors.textBright, attributes: TextAttributes.BOLD };
                    case "seller":
                      return { text: row.sellerName, color: colors.text };
                    case "shares":
                      return { text: fmtShares(row.shares), value: row.shares, color: colors.text };
                    case "value":
                      return { text: fmtUsd(row.marketValueUsd), value: row.marketValueUsd ?? undefined, color: colors.negative };
                    case "plan":
                      return { text: row.plan10b51Date ?? "Discretionary", color: row.plan10b51Date ? colors.textDim : colors.warning };
                    default:
                      return { text: row.brokerName ?? MISSING_VALUE, color: colors.textDim };
                  }
                }}
              />
            ) : (
              <DataTableView
                focused={focused}
                rootWidth={width}
                columns={scanShelfCols}
                items={scanShelvesRes.data?.rows ?? []}
                sortColumnId="atm"
                sortDirection="desc"
                emptyStateTitle="No active shelves found."
                getItemKey={(row) => row.accession}
                selection={{
                  kind: "id",
                  selectedId,
                  getId: (r) => r.accession,
                  onChange: setSelectedId,
                }}
                onActivate={(row) => openTickerDilution(row.symbol)}
                onRootKeyDown={handleKey}
                renderCell={(row, col): DataTableCell => {
                  switch (col.id) {
                    case "symbol":
                      return { text: row.symbol, color: colors.textBright, attributes: TextAttributes.BOLD };
                    case "company":
                      return { text: row.companyName, color: colors.text };
                    case "form":
                      return { text: row.form, color: row.isWksi ? colors.warning : colors.textBright };
                    case "cap":
                      return { text: row.registeredAmountUsd ? fmtUsd(row.registeredAmountUsd) : row.isWksi ? "WKSI" : MISSING_VALUE, color: colors.textBright };
                    case "atm":
                      return { text: String(row.recentAtmCount), value: row.recentAtmCount, color: row.recentAtmCount > 0 ? colors.warning : colors.textDim };
                    case "drawn":
                      return { text: fmtUsd(row.recentOfferingsUsd), value: row.recentOfferingsUsd, color: colors.text };
                    case "expiry":
                      return dayCell(row.expiryDate);
                    default:
                      return { text: row.babyShelfRestricted ? "I.B.6 1/3" : row.isWksi ? "WKSI" : "Rule 415", color: row.babyShelfRestricted ? colors.negative : colors.textDim };
                  }
                }}
              />
            )}
          </PaneStatusBody>
        </Box>
      ) : !symbol ? (
        <PaneStatusBody
          loading={false}
          error={null}
          empty
          emptyTitle="Select a ticker or switch to the Scanner tab."
          subject="equity dilution"
        >
          {null}
        </PaneStatusBody>
      ) : (
        <PaneStatusBody
          loading={!company && companyRes.loading}
          error={!company ? companyRes.error : null}
          empty={!company && !companyRes.loading && !companyRes.error}
          emptyTitle={`No SEC dilution, ATM or Form 144 records found for ${symbol}.`}
          subject="equity dilution"
        >
          {company && metrics ? (
            <Box flexDirection="column" flexGrow={1} minHeight={0}>
              {activeTab === "overview" && (
                <Box flexDirection="column" flexGrow={1} minHeight={0}>
                  <StatGrid items={overviewStats} width={width} />
                  <Box flexDirection="row" paddingX={1} paddingY={0} gap={2}>
                    <Text fg={colors.textDim}>{shelfCapacitySummary(metrics)}</Text>
                    {capacityBar ? <Text fg={colors.warning}>{capacityBar}</Text> : null}
                  </Box>
                  {metrics.signals.slice(0, 2).map((sig) => (
                    <Notice key={sig} tone={metrics.riskTier === "high" ? "warning" : "muted"}>
                      {sig}
                    </Notice>
                  ))}
                  <DataTableView<DilutionShelfRow>
                    focused={focused}
                    rootWidth={width}
                    columns={shelfCols}
                    items={company.shelves}
                    sortColumnId="filed"
                    sortDirection="desc"
                    getItemKey={(row) => row.accession}
                    selection={{
                      kind: "id",
                      selectedId,
                      getId: (r) => r.accession,
                      onChange: setSelectedId,
                    }}
                    onActivate={(row) => {
                      void host.openExternal(row.sourceUrl).catch(logFailure("equity-dilution", "open external filing failed"));
                    }}
                    onRootKeyDown={handleKey}
                    emptyStateTitle="No SEC shelf registrations on record."
                    renderCell={(row, col): DataTableCell => {
                      switch (col.id) {
                        case "form":
                          return { text: row.isWksi ? `${row.form}*` : row.form, color: colors.textBright, attributes: TextAttributes.BOLD };
                        case "filed":
                          return dayCell(row.filingDate);
                        case "expiry":
                          return {
                            text: row.expiryDate
                              ? `${row.expiryDate}${row.daysToExpiry != null && row.daysToExpiry >= 0 ? ` (${row.daysToExpiry}d)` : ""}`
                              : MISSING_VALUE,
                            color: row.daysToExpiry != null && row.daysToExpiry < 90 ? colors.warning : colors.text,
                          };
                        case "cap":
                          return { text: row.registeredAmountUsd ? fmtUsd(row.registeredAmountUsd) : row.isWksi ? "Uncapped" : MISSING_VALUE, color: colors.textBright };
                        case "status":
                          return {
                            text: row.status.toUpperCase(),
                            color: row.status === "active" ? colors.positive : colors.textDim,
                          };
                        default:
                          return { text: row.securityTypes.join(", ") || MISSING_VALUE, color: colors.textDim };
                      }
                    }}
                  />
                </Box>
              )}

              {activeTab === "offerings" && (
                <DataTableView<DilutionOfferingRow>
                  focused={focused}
                  rootWidth={width}
                  columns={offCols}
                  items={company.offerings}
                  sortColumnId="filed"
                  sortDirection="desc"
                  getItemKey={(row) => row.accession}
                  selection={{
                    kind: "id",
                    selectedId,
                    getId: (r) => r.accession,
                    onChange: setSelectedId,
                  }}
                  onActivate={(row) => {
                    void host.openExternal(row.sourceUrl).catch(logFailure("equity-dilution", "open external filing failed"));
                  }}
                  onRootKeyDown={handleKey}
                  emptyStateTitle={`No 424B5/424B7 offerings recorded for ${company.symbol}.`}
                  renderCell={(row, col): DataTableCell => {
                    switch (col.id) {
                      case "filed":
                        return dayCell(row.filingDate);
                      case "type":
                        return {
                          text: offeringTypeShort(row.offeringType),
                          color: row.offeringType === "atm" ? colors.warning : row.offeringType === "secondary" ? colors.textDim : colors.textBright,
                          attributes: row.offeringType === "atm" ? TextAttributes.BOLD : undefined,
                        };
                      case "form":
                        return { text: row.form, color: colors.textDim };
                      case "amount":
                        return { text: fmtUsd(row.amountUsd), value: row.amountUsd ?? undefined, color: colors.textBright };
                      case "shares":
                        return { text: fmtShares(row.shares), value: row.shares ?? undefined, color: colors.text };
                      default:
                        return { text: row.salesAgent ?? MISSING_VALUE, color: colors.textDim };
                    }
                  }}
                />
              )}

              {activeTab === "form144" && (
                <Box flexDirection="column" flexGrow={1} minHeight={0}>
                  <QueryBar
                    width={width}
                    filters={[
                      {
                        id: "plan",
                        label: "Filter",
                        inline: true,
                        value: planFilter,
                        options: [...F144_FILTER_OPTIONS],
                        onChange: (v: string) => setPlanFilter(v as "all" | "plan"),
                      },
                    ]}
                  />
                  <DataTableView<DilutionForm144Row>
                    focused={focused}
                    rootWidth={width}
                    columns={f144Cols}
                    items={filteredCompany144}
                    sortColumnId="filed"
                    sortDirection="desc"
                    getItemKey={(row) => row.accession}
                    selection={{
                      kind: "id",
                      selectedId,
                      getId: (r) => r.accession,
                      onChange: setSelectedId,
                    }}
                    onActivate={(row) => {
                      void host.openExternal(row.sourceUrl).catch(logFailure("equity-dilution", "open external filing failed"));
                    }}
                    onRootKeyDown={handleKey}
                    emptyStateTitle={`No Form 144 notices on record for ${company.symbol}.`}
                    renderCell={(row, col): DataTableCell => {
                      switch (col.id) {
                        case "filed":
                          return dayCell(row.filingDate);
                        case "seller":
                          return { text: row.sellerName, color: colors.textBright };
                        case "shares":
                          return { text: fmtShares(row.shares), value: row.shares, color: colors.text };
                        case "value":
                          return { text: fmtUsd(row.marketValueUsd), value: row.marketValueUsd ?? undefined, color: colors.negative };
                        case "plan":
                          return { text: row.plan10b51Date ?? "Discretionary", color: row.plan10b51Date ? colors.textDim : colors.warning };
                        default:
                          return { text: row.brokerName ?? MISSING_VALUE, color: colors.textDim };
                      }
                    }}
                  />
                </Box>
              )}
            </Box>
          ) : null}
        </PaneStatusBody>
      )}
    </Box>
  );
}
