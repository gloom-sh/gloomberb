import { useCallback, useMemo, useState } from "react";
import { TextAttributes, useRendererHost } from "../../../ui";
import {
  DataTableView,
  EmptyState,
  PaneStatusBody,
  usePaneFooter,
  usePaneNoticeFooter,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import { handleRefreshKey, loadingErrorFooterInfo } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { colors, priceColor } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { nextHeaderSort } from "../../../utils/sort-values";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { openSecFilingInPane } from "../sec/command-bar-search";
import { cachedBeneficialOwners, loadBeneficialOwners } from "./beneficial-client";
import { beneficialCoverageNotices, beneficialListUnreadable } from "./beneficial-report";
import {
  buildBeneficialColumns,
  buildBeneficialRows,
  DEFAULT_BENEFICIAL_SORT,
  formatFilerName,
  formatOwnerShares,
  formatPercentOfClass,
  formatPointChange,
  sortBeneficialRows,
  stakeMarker,
  type BeneficialColumn,
  type BeneficialColumnId,
  type BeneficialOwnerRow,
  type BeneficialSortPreference,
} from "./beneficial-model";
import type { Holder13FMatch } from "./thirteenf-match";
import type { HolderRow } from "./types";

const STALE_SEGMENT = { id: "stale", parts: [{ text: "stale", tone: "warning" as const }] };

/**
 * The 13D/G tab: who disclosed more than 5% of the class, the stake each
 * filer's latest report gives and how it moved, one row per filer, joined to
 * the Table tab's 13F holders for the quarter's action. A latest report is
 * the latest disclosure, not today's position.
 */
export function BeneficialOwnersView({
  focused,
  width,
  symbol,
  holderRows,
  fundMatches,
  onCycleView,
  onRefreshHolders,
}: {
  focused: boolean;
  width: number;
  symbol: string | null;
  holderRows: readonly HolderRow[];
  fundMatches: ReadonlyMap<string, Holder13FMatch>;
  onCycleView: () => void;
  onRefreshHolders: () => void;
}) {
  const rendererHost = useRendererHost();
  const { createPaneFromTemplate } = usePluginAppActions();
  const session = useResearchCloudSession();
  const [sortPreference, setSortPreference] = usePluginPaneState<BeneficialSortPreference>(
    "beneficialSort",
    DEFAULT_BENEFICIAL_SORT,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A session change retries a request the sign-in wall was shown for.
  const loader = useMemo(
    () => symbol ? (force: boolean) => loadBeneficialOwners(symbol, force) : null,
    [symbol, session.requestKey],
  );
  const resource = useAsyncResource(loader, {
    initialData: () => symbol ? cachedBeneficialOwners(symbol) : null,
    clearOnError: (error) => error instanceof Error && isCloudSessionRequired(error.message),
  });
  useAutoRefresh(resource.updatedAt, resource.load);
  const payload = resource.data?.payload ?? null;

  const rows = useMemo(
    () => buildBeneficialRows(payload?.owners ?? [], holderRows, fundMatches),
    [fundMatches, holderRows, payload],
  );
  const sortedRows = useMemo(() => sortBeneficialRows(rows, sortPreference), [rows, sortPreference]);
  const columns = useMemo(() => buildBeneficialColumns(width), [width]);
  const selectedRow = sortedRows.find((row) => row.id === selectedId) ?? sortedRows[0] ?? null;

  const openFiling = useCallback((row: BeneficialOwnerRow | null | undefined) => {
    if (!row || !symbol) return;
    openSecFilingInPane({ createPaneFromTemplate }, symbol, row.filing.accessionNumber);
  }, [createPaneFromTemplate, symbol]);

  const openFilingUrl = useCallback(() => {
    const url = selectedRow?.filing.filingUrl;
    if (url) void rendererHost.openExternal(url);
  }, [rendererHost, selectedRow]);

  const refresh = useCallback(() => {
    void resource.reload();
    onRefreshHolders();
  }, [onRefreshHolders, resource]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (handleRefreshKey(event, refresh, { stopPropagation: true })) return true;
    if (isPlainKey(event, "s")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      onCycleView();
      return true;
    }
    return false;
  }, [onCycleView, refresh]);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextHeaderSort(current, columnId as BeneficialColumnId, {
      firstDirection: (id) => id === "filer" || id === "form" ? "asc" : "desc",
    }));
  }, [setSortPreference]);

  const renderCell = useCallback((
    row: BeneficialOwnerRow,
    column: BeneficialColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const { filing } = row;
    // A report of zero reads as history; a stake under 5% is still a stake.
    const exited = row.stake === "exited";
    const tone = exited ? colors.textMuted : colors.text;
    switch (column.id) {
      case "filer":
        return {
          text: formatFilerName(filing.filerName, Math.max(0, filing.reportingPersons.length - 1), column.width),
          value: filing.filerName,
          color: exited ? colors.textMuted : rowState.selected ? colors.selectedText : colors.textBright,
          attributes: exited ? undefined : TextAttributes.BOLD,
        };
      case "form":
        return { text: row.formLabel, color: tone };
      case "percentOfClass": {
        // A column too narrow for `4.9% <5%` keeps the figure alone.
        const marker = column.width >= formatPercentOfClass(row, { marker: true }).length;
        return {
          text: formatPercentOfClass(row, { marker }),
          value: filing.percentOfClass,
          color: row.stake === "holder" ? colors.textBright : stakeMarker(row.stake) ? colors.textDim : colors.text,
        };
      }
      case "change":
        return {
          text: formatPointChange(row.changePoints),
          value: row.changePoints,
          color: row.changePoints == null || row.changePoints === 0 ? colors.textDim : priceColor(row.changePoints),
        };
      case "shares":
        return { text: formatOwnerShares(filing.shares), value: filing.shares, color: tone };
      case "eventDate":
        return { text: filing.eventDate ?? "-", value: filing.eventDate, color: colors.textDim };
      case "filingDate":
        return { text: filing.filingDate, value: filing.filingDate, color: colors.textDim };
      case "thirteenF": {
        const action = row.thirteenF;
        if (!action) return { text: "-", value: null, color: colors.textDim };
        return { text: action.label, color: action.value === 0 ? colors.textDim : priceColor(action.value) };
      }
    }
  }, []);

  const authWall = !payload && isCloudSessionRequired(resource.error);
  const error = authWall ? null : resource.error;
  // Listed filings that could not be read are a failure, not "no filings".
  const unreadable = !!payload && beneficialListUnreadable(payload);
  const coverageNotices = useMemo(
    () => unreadable ? [] : beneficialCoverageNotices(payload?.coverage),
    [payload, unreadable],
  );
  usePaneNoticeFooter({
    registrationId: "holders-13dg:coverage",
    notices: coverageNotices,
    focused,
    title: "13D/13G coverage",
  });
  usePaneFooter("holders-13dg", () => ({
    info: [
      ...(payload?.asOf ? [{ id: "as-of", parts: [{ text: `as of ${payload.asOf.slice(0, 10)}`, tone: "muted" as const }] }] : []),
      ...(payload && resource.data?.stale ? [STALE_SEGMENT] : []),
      ...loadingErrorFooterInfo(resource.loading, payload ? error : null),
    ],
    hints: selectedRow?.filing.filingUrl
      ? [{ id: "filing", key: "o", label: "pen filing", onPress: openFilingUrl }]
      : [],
  }), [error, openFilingUrl, payload, resource.data?.stale, resource.loading, selectedRow]);

  if (!symbol) return <EmptyState title="No ticker selected." />;
  if (authWall) {
    return <SignInWall placement="holders-13dg-signin" action="view 13D/13G filings" needsVerification={session.needsVerification} />;
  }

  return (
    <PaneStatusBody
      loading={resource.loading && !payload}
      error={!payload ? error
        : unreadable ? `${payload.coverage?.filings ?? 0} filings are listed for ${symbol} but none could be read this time. A refresh retries them.`
        : null}
      subject="13D/13G filings"
      empty={!!payload && sortedRows.length === 0}
      emptyTitle={`No 13D/13G filings in the last 4 years for ${symbol}.`}
    >
      <DataTableView<BeneficialOwnerRow, BeneficialColumn>
        focused={focused}
        selection={{
          kind: "id",
          selectedId: selectedRow?.id ?? null,
          getId: (row) => row.id,
          onChange: (id) => setSelectedId(id),
        }}
        onActivate={openFiling}
        onRootKeyDown={handleKeyDown}
        resetScrollKey={symbol}
        rootWidth={width}
        columns={columns}
        items={sortedRows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={handleHeaderClick}
        getItemKey={(row) => row.id}
        renderCell={renderCell}
        selectedTextOverridesCellColor
        emptyStateTitle={`No 13D/13G filings in the last 4 years for ${symbol}.`}
      />
    </PaneStatusBody>
  );
}
