import { Box, Text, useUiCapabilities } from "../../../../ui";
import { TextAttributes, type ScrollBoxRenderable } from "../../../../ui";
import { useShortcut } from "../../../../react/input";
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { usePaneStateValue, usePaneTicker } from "../../../../state/app/context";
import {
  DataTableView,
  DisclosureMarker,
  PaneStatusBody,
  QueryBar,
  usePaneFooter,
  usePaneNoticeFooter,
  type DataTableCell,
  type DataTableColumn,
} from "../../../../components";
import { colors, priceColor } from "../../../../theme/colors";
import { fiscalYearEndMonth } from "../../../../utils/fiscal-period";
import { displayWidth, padTo } from "../../../../utils/format";
import { filledPeriodPublications, filledPeriodsNote, stalePeriodNote } from "../../../../utils/financial-statements";
import {
  FINANCIAL_COL_W,
  financialLabelWidth,
  financialPeriodWidth,
  FINANCIAL_SUB_TABS,
  buildFinancialRows,
  canCompareFinancialRow,
  collectDefaultCollapsedGroupIds,
  collectGroupIds,
  computeGrowth,
  financialCellValue,
  financialColumnLabel,
  formatFinancialCell,
  financialStatementCurrency,
  financialStatementLimitations,
  financialStatementPeriods,
  financialSubTabFields,
  formatFinancialValue,
  latestFinancialPeriodEnd,
  notInYetNote,
  resolveFinancialPeriod,
  resolveFinancialPeriodOption,
  semanticGrowthValue,
  selectFinancialStatements,
  shareFinancialUnit,
  splitPeriodsNotInYet,
  type FinancialPeriod,
  type FinancialTableRow,
} from "./model";
import type { FinancialTableStatement } from "./aggregation";
import {
  FINANCIAL_SECTIONS,
  RATIO_TABS,
  buildRatioTableModel,
  oldestRatioPeriodEnd,
  periodEndClose,
  ratioOpenings,
  ratioPeriodEnd,
  ratioPeriods,
  resolveFinancialSectionKey,
  visibleRatios,
  type RatioAmount,
} from "./ratios";
import { PeriodEndHistoryLoader, RatioTable, ratioMetricColumn, type PeriodEndHistoryState, type RatioTableColumn } from "./ratio-table";
import { useExchangeResultsNotes } from "./exchange-results";
import { latestBalanceSheetDate, useOfferingNote } from "./offerings";
import { useBoundTicker } from "../../shared/ticker-request";
import { createValuationCurrencyContext } from "../../../../time-series/valuation-currency";

const RATIOS_SEGMENT = "ratios";

type FinancialTableColumn = DataTableColumn & (
  | { id: "metric"; kind: "metric" }
  | { id: string; kind: "statement"; statement: FinancialTableStatement }
);

const NO_COLLAPSED_GROUPS: ReadonlySet<string> = new Set();

/**
 * A group's name in the metric column. It draws its indent (an empty one still takes a cell), its disclosure
 * and its name a cell apart, and says that width (`contentWidth`) so the table fits the column to it whole.
 * The desktop draws the disclosure as a path, not a glyph.
 */
export function financialGroupNameCell(
  row: Extract<FinancialTableRow, { kind: "group" }>,
  color: string,
  attributes: number,
): Pick<DataTableCell, "text" | "contentWidth" | "content"> {
  const indent = " ".repeat(row.depth * 2);
  const marker = row.toggleable ? (row.expanded ? "\u25be" : "\u25b8") : " ";
  return {
    text: `${indent}${marker} ${row.unitLabel}`,
    contentWidth: Math.max(1, displayWidth(indent)) + 1 + displayWidth(marker) + 1 + displayWidth(row.unitLabel),
    content: (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text fg={color}>{indent}</Text>
        {row.toggleable ? <DisclosureMarker expanded={!!row.expanded} color={color} /> : <Text> </Text>}
        <Text fg={color} attributes={attributes}>{row.unitLabel}</Text>
      </Box>
    ),
  };
}
const financialRowKey = (row: FinancialTableRow) => row.id;
const financialRowBackground = (row: FinancialTableRow) => (
  row.kind === "group" && row.depth === 0 ? colors.panel : undefined
);

/** The fiscal period, plus the column's currency when the table has no single one. */
function financialColumnHeader(
  statement: FinancialTableStatement,
  kind: FinancialPeriod,
  yearEndMonth: number | null,
  sharedCurrency: string | undefined,
): string {
  const header = financialColumnLabel(statement, kind, yearEndMonth);
  return !sharedCurrency && statement.currency ? `${header} ${statement.currency}` : header;
}

export function ResolvedFinancialsTab({
  width,
  focused,
  financials,
  headerScrollId,
  bodyScrollId,
  allowArrowSubTabNavigation = true,
}: {
  width: number;
  focused: boolean;
  financials: ReturnType<typeof usePaneTicker>["financials"];
  headerScrollId?: string;
  bodyScrollId?: string;
  allowArrowSubTabNavigation?: boolean;
}) {
  // Keyed on the snapshot so the derived statement lists, columns, and rows
  // below keep their identity across renders that only move the selection;
  // the table memoizes rows on exactly those references.
  const annualStatements = useMemo(
    () => [...(financials?.annualStatements ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [financials],
  );
  const quarterlyStatements = useMemo(
    () => [...(financials?.quarterlyStatements ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [financials],
  );
  const comparisonCurrency = financialStatementCurrency(financials, [...annualStatements, ...quarterlyStatements]);
  const hasAnnualStatements = annualStatements.length > 0;
  const hasQuarterlyStatements = quarterlyStatements.length > 0;
  const fallbackPeriod: FinancialPeriod = hasAnnualStatements ? "annual" : "quarterly";
  const [storedPeriod, setStoredPeriod] = usePaneStateValue<FinancialPeriod>("financialPeriod", fallbackPeriod);
  const period = resolveFinancialPeriodOption(storedPeriod) ?? fallbackPeriod;
  const [storedSubTab, setStoredSubTab] = usePaneStateValue<string>("financialSubTab", FINANCIAL_SUB_TABS[0]!.key);
  const resolvedSubTabKey = resolveFinancialSectionKey(storedSubTab);
  const subTabIdx = Math.max(0, FINANCIAL_SECTIONS.findIndex((tab) => tab.key === resolvedSubTabKey));
  // Ratios open collapsed: the inputs behind each one show on demand.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set([
    ...collectDefaultCollapsedGroupIds(FINANCIAL_SUB_TABS.flatMap((tab) => tab.rows)),
    ...RATIO_TABS.flatMap((tab) => tab.ratios.map((ratio) => ratio.id)),
  ]));
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const bodyScrollRef = useRef<ScrollBoxRenderable>(null);
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);
  const { nativePaneChrome } = useUiCapabilities();
  const section = FINANCIAL_SECTIONS[subTabIdx]!;
  const ratioTab = section.kind === "ratio" ? section.tab : null;
  // A ratio tab builds its own rows; the statement rows below idle on Income.
  const subTab = section.kind === "statement" ? section.tab : FINANCIAL_SUB_TABS[0]!;
  // A ratio read over one quarter is not on the annual view, so its state does not count there.
  const quarterlyView = resolveFinancialPeriod(period, hasAnnualStatements, hasQuarterlyStatements) === "quarterly";
  const currentGroupIds = useMemo(
    () => ratioTab ? visibleRatios(ratioTab, quarterlyView).map((ratio) => ratio.id) : collectGroupIds(subTab.rows),
    [quarterlyView, ratioTab, subTab],
  );
  const hasCollapsedCurrentGroup = currentGroupIds.some((id) => collapsedGroups.has(id));
  const hasExpandedCurrentGroup = currentGroupIds.some((id) => !collapsedGroups.has(id));
  const setPeriod = useCallback((next: SetStateAction<FinancialPeriod>) => {
    setStoredPeriod(next);
  }, [setStoredPeriod]);
  const setSubTabIdx = useCallback((next: SetStateAction<number>) => {
    setStoredSubTab((currentKey) => {
      const currentSubTabKey = resolveFinancialSectionKey(currentKey);
      const currentIndex = Math.max(0, FINANCIAL_SECTIONS.findIndex((tab) => tab.key === currentSubTabKey));
      const rawIndex = typeof next === "function" ? next(currentIndex) : next;
      const boundedIndex = ((rawIndex % FINANCIAL_SECTIONS.length) + FINANCIAL_SECTIONS.length) % FINANCIAL_SECTIONS.length;
      return FINANCIAL_SECTIONS[boundedIndex]?.key ?? FINANCIAL_SECTIONS[0]!.key;
    });
  }, [setStoredSubTab]);
  const selectSection = useCallback((key: string) => {
    setSubTabIdx(Math.max(0, FINANCIAL_SECTIONS.findIndex((tab) => tab.key === key)));
  }, [setSubTabIdx]);
  // The Ratios segment reopens the ratio tab last read.
  const [lastRatioKey, setLastRatioKey] = usePaneStateValue<string>("financialRatioTab", RATIO_TABS[0]!.key);
  useEffect(() => {
    if (ratioTab && ratioTab.key !== lastRatioKey) setLastRatioKey(ratioTab.key);
  }, [lastRatioKey, ratioTab, setLastRatioKey]);
  const selectAdjacentSubTab = useCallback((direction: -1 | 1) => {
    setSubTabIdx((current) => current + direction);
  }, [setSubTabIdx]);
  const togglePeriod = useCallback(() => {
    if (!hasAnnualStatements && !hasQuarterlyStatements) return;
    setPeriod((current) => {
      const resolved = resolveFinancialPeriod(current, hasAnnualStatements, hasQuarterlyStatements);
      if (resolved === "annual" && hasQuarterlyStatements) return "quarterly";
      if (hasAnnualStatements) return "annual";
      return "quarterly";
    });
  }, [hasAnnualStatements, hasQuarterlyStatements, setPeriod]);
  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);
  const expandCurrentGroups = useCallback(() => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      for (const groupId of currentGroupIds) next.delete(groupId);
      return next;
    });
  }, [currentGroupIds]);
  const collapseCurrentGroups = useCallback(() => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      for (const groupId of currentGroupIds) next.add(groupId);
      return next;
    });
  }, [currentGroupIds]);

  // The active section and period are already the visible tab selections, so the
  // footer only carries what the controls cannot show.
  usePaneFooter("financials", () => ({
    info: [],
    hints: [
      {
        id: "section",
        key: `1-${FINANCIAL_SECTIONS.length}`,
        label: "section",
        disabled: !financials,
        onPress: () => setSubTabIdx((current) => (current + 1) % FINANCIAL_SECTIONS.length),
      },
      {
        id: "period",
        key: "p",
        label: "eriod",
        disabled: !hasAnnualStatements && !hasQuarterlyStatements,
        onPress: togglePeriod,
      },
      {
        id: "expand-groups",
        key: "e",
        label: "xpand",
        disabled: !hasCollapsedCurrentGroup,
        onPress: expandCurrentGroups,
      },
      {
        id: "collapse-groups",
        key: "c",
        label: "ollapse",
        disabled: !hasExpandedCurrentGroup,
        onPress: collapseCurrentGroups,
      },
    ],
  }), [
    collapseCurrentGroups,
    expandCurrentGroups,
    financials,
    hasAnnualStatements,
    hasCollapsedCurrentGroup,
    hasExpandedCurrentGroup,
    hasQuarterlyStatements,
    setSubTabIdx,
    togglePeriod,
  ]);

  const syncHeaderScroll = useCallback(() => {
    const body = bodyScrollRef.current;
    const header = headerScrollRef.current;
    if (body && header && header.scrollLeft !== body.scrollLeft) {
      header.scrollLeft = body.scrollLeft;
    }
  }, []);

  useShortcut((event) => {
    if (!focused) return;
    if (event.ctrl || event.meta || event.alt || event.super || event.targetEditable) return;
    const keyName = event.name || event.key || event.sequence;
    if (keyName === "p") {
      event.preventDefault();
      event.stopPropagation();
      togglePeriod();
    } else if (keyName === "e" && hasCollapsedCurrentGroup) {
      event.preventDefault();
      event.stopPropagation();
      expandCurrentGroups();
    } else if (keyName === "c" && hasExpandedCurrentGroup) {
      event.preventDefault();
      event.stopPropagation();
      collapseCurrentGroups();
    } else if (/^[1-9]$/.test(keyName ?? "") && Number(keyName) <= FINANCIAL_SECTIONS.length) {
      event.preventDefault();
      event.stopPropagation();
      setSubTabIdx(Number(keyName) - 1);
    } else if (allowArrowSubTabNavigation && keyName === "left") {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentSubTab(-1);
    } else if (allowArrowSubTabNavigation && keyName === "right") {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentSubTab(1);
    }
  }, { phase: "before" });

  useEffect(() => {
    if (period === "annual" && !hasAnnualStatements && hasQuarterlyStatements) {
      setPeriod("quarterly");
    } else if (period === "quarterly" && !hasQuarterlyStatements && hasAnnualStatements) {
      setPeriod("annual");
    }
  }, [hasAnnualStatements, hasQuarterlyStatements, period, setPeriod]);

  const resolvedPeriod = resolveFinancialPeriod(period, hasAnnualStatements, hasQuarterlyStatements);
  const isAnnual = resolvedPeriod === "annual";
  const selected = useMemo(
    () => selectFinancialStatements(resolvedPeriod, subTab.key, annualStatements, quarterlyStatements, undefined, financials?.trailingStatement),
    [annualStatements, quarterlyStatements, resolvedPeriod, subTab.key, financials?.trailingStatement],
  );
  // A newest period with only some figures (an EPS alone) is left out of a statement table, and a line says so.
  const { shown: displayStatements, notInYet } = useMemo(
    () => ratioTab ? { shown: selected.statements, notInYet: [] } : splitPeriodsNotInYet(selected.statements, subTab),
    [ratioTab, selected.statements, subTab],
  );
  const previousStatementMap = selected.previousStatementMap;
  // One currency for every column goes in the query bar with the growth basis;
  // a column in a different currency (or none) says so in its own header.
  const growthBasis = isAnnual ? "YoY" : "QoQ";
  const yearEndMonth = useMemo(() => fiscalYearEndMonth(annualStatements), [annualStatements]);
  const annualDates = useMemo(() => new Set(annualStatements.map(({ date }) => date)), [annualStatements]);
  const { rows, unit } = useMemo(
    () => shareFinancialUnit(buildFinancialRows(subTab.rows, displayStatements, collapsedGroups)),
    [collapsedGroups, displayStatements, subTab.rows],
  );
  // The money unit most rows share heads the line names, so it is never cut with the query bar's text; rows in
  // another unit say theirs ("Interest Exp (mn)"), which the header says it leaves to them.
  const moneyUnit = [comparisonCurrency, unit].filter(Boolean).join(" ");
  const unitMarked = !!unit && rows.some((row) => row.unitLabel !== row.label);
  const metricHeader = moneyUnit ? `${moneyUnit}${unitMarked ? " unless marked" : ""}` : "Metric";
  // The annual balance sheet leads with a newer quarter-end position.
  const periodHeaders = useMemo(() => displayStatements.map((statement) => financialColumnHeader(
    statement,
    isAnnual && (statement.date === "TTM" || annualDates.has(statement.date)) ? "annual" : "quarterly",
    yearEndMonth,
    comparisonCurrency,
  )), [annualDates, comparisonCurrency, displayStatements, isAnnual, yearEndMonth]);
  // In the terminal a period is as wide as its widest value and growth, so each pair sits as far from the next
  // as from its own growth and more periods fit. The ratio tabs keep the statement columns' width. Every line of
  // the statement counts, a collapsed group's too, so opening or closing one leaves the periods where they are.
  const periodWidth = useMemo(() => {
    if (nativePaneChrome || ratioTab) return FINANCIAL_COL_W;
    const everyRow = shareFinancialUnit(buildFinancialRows(subTab.rows, displayStatements, NO_COLLAPSED_GROUPS)).rows;
    const values = [...everyRow, ...rows].flatMap((row) => displayStatements.map((statement) => (
      formatFinancialValue(financialCellValue(row, statement), row, statement)
    )));
    return financialPeriodWidth(values, periodHeaders);
  }, [displayStatements, nativePaneChrome, periodHeaders, ratioTab, rows, subTab.rows]);
  const columns = useMemo<FinancialTableColumn[]>(() => [
    {
      id: "metric",
      kind: "metric",
      label: metricHeader,
      width: financialLabelWidth(width),
      align: "left",
    },
    ...displayStatements.map((statement, index): FinancialTableColumn => ({
      id: `statement:${statement.date}:${index}`,
      kind: "statement",
      statement,
      label: padTo(periodHeaders[index]!, periodWidth, "center"),
      width: periodWidth,
      align: "right",
      headerColor: statement.date === "TTM" ? colors.textBright : colors.textDim,
    })),
  ], [displayStatements, metricHeader, periodHeaders, periodWidth, width]);
  const periodEnd = latestFinancialPeriodEnd(displayStatements);
  const renderCell = useCallback((
    row: FinancialTableRow,
    column: FinancialTableColumn,
  ): DataTableCell => {
    if (column.kind === "metric") {
      if (row.kind === "group") {
        const labelColor = row.depth === 0 ? colors.textBright : colors.textDim;
        const labelAttributes = row.depth === 0 ? TextAttributes.BOLD : TextAttributes.NONE;
        return {
          ...financialGroupNameCell(row, labelColor, labelAttributes),
          color: labelColor,
          attributes: labelAttributes,
          onMouseDown: row.toggleable
            ? (event) => {
              event.preventDefault?.();
              event.stopPropagation?.();
              toggleGroup(row.id);
            }
            : undefined,
        };
      }

      return {
        text: `${" ".repeat(row.depth * 2 + 2)}${row.unitLabel}`,
        color: colors.textDim,
      };
    }

    if (row.kind === "group" && !row.summaryKey) return {
      text: "",
    };

    const previous = previousStatementMap.get(column.statement.date);
    const value = financialCellValue(row, column.statement);
    const previousValue = previous ? financialCellValue(row, previous) : undefined;
    const growth = (row.kind === "metric" && !row.showGrowth)
      || !canCompareFinancialRow(row, column.statement, previous, comparisonCurrency)
      ? undefined : computeGrowth(value, previousValue);
    const formattedValue = formatFinancialValue(value, row, column.statement);
    const cell = formatFinancialCell(formattedValue, growth, column.width);
    const growthColorValue = semanticGrowthValue(growth, row.growthDirection);

    return {
      text: `${cell.valueText}${cell.growthText}`,
      content: (
        <Box flexDirection="row" width={column.width}>
          <Text
            attributes={row.kind === "group" ? TextAttributes.BOLD : TextAttributes.NONE}
            fg={colors.text}
          >
            {cell.valueText}
          </Text>
          <Text
            attributes={row.kind === "group" ? TextAttributes.BOLD : TextAttributes.NONE}
            fg={growthColorValue != null ? priceColor(growthColorValue) : colors.text}
          >
            {cell.growthText}
          </Text>
        </Box>
      ),
    };
  }, [comparisonCurrency, previousStatementMap, toggleGroup]);
  useEffect(() => {
    if (rows.length === 0) {
      if (selectedRowId !== null) setSelectedRowId(null);
      return;
    }
    if (selectedRowId && rows.some((row) => row.id === selectedRowId)) return;
    setSelectedRowId(rows[0]!.id);
  }, [rows, selectedRowId]);

  // Ratio tabs share the statement columns: Income's periods, with TTM.
  const isValuation = ratioTab?.key === "valuation";
  const oldestPeriodEnd = oldestRatioPeriodEnd(displayStatements);
  const [loadedHistory, setHistory] = useState<PeriodEndHistoryState | null>(null);
  const history: PeriodEndHistoryState = isValuation && loadedHistory ? loadedHistory : { data: undefined, loading: isValuation, error: null };
  const currencies = useMemo(() => financials ? createValuationCurrencyContext(financials) : null, [financials]);
  const ratioModel = useMemo(() => {
    if (!ratioTab) return null;
    const openings = ratioOpenings(resolvedPeriod, annualStatements, quarterlyStatements);
    const price = (statement: FinancialTableStatement): RatioAmount => {
      if (!isValuation) return "no-price";
      if (!history.data) return history.error && !history.loading ? "no-price" : "loading";
      const close = periodEndClose(history.data, ratioPeriodEnd(statement));
      return (close === undefined ? null : currencies?.priceInStatementUnits(statement, close)) ?? "no-price";
    };
    const expanded = new Set(ratioTab.ratios.map((ratio) => ratio.id).filter((id) => !collapsedGroups.has(id)));
    return buildRatioTableModel(ratioTab, ratioPeriods(displayStatements, openings, resolvedPeriod, price, { annual: annualStatements, quarterly: quarterlyStatements }), expanded, financials?.profile);
  }, [
    annualStatements, collapsedGroups, currencies, displayStatements, history.data, history.error, history.loading,
    isValuation, quarterlyStatements, ratioTab, resolvedPeriod, financials?.profile,
  ]);
  const ratioColumns = useMemo<RatioTableColumn[]>(() => [
    ratioMetricColumn(width),
    ...columns.flatMap((column, index) => column.kind === "statement" ? [{ ...column, index: index - 1 }] : []),
  ], [columns, width]);

  // The Balance Sheet and Liquidity show cash, which an offering filed since the latest balance sheet is not in yet.
  const { symbol: boundSymbol, exchange: boundExchange } = useBoundTicker();
  // Years filled from the listing's exchange, with the lines this table shows.
  const filledFields = useMemo(() => ratioTab ? undefined : financialSubTabFields(subTab), [ratioTab, subTab]);
  const filledPeriods = useMemo(() => filledPeriodsNote(displayStatements, filledFields), [displayStatements, filledFields]);
  const filledDates = useMemo(() => filledPeriodPublications(displayStatements, filledFields), [displayStatements, filledFields]);
  // An HKEX company's latest period dated by its results announcement, unless the filled periods already date it, and
  // what was announced after it.
  const exchangeResults = useExchangeResultsNotes(boundSymbol, boundExchange, latestBalanceSheetDate(financials), filledDates);
  const offeringNote = useOfferingNote(boundSymbol, boundExchange, latestBalanceSheetDate(financials),
    !!financials && (section.key === "balance" || section.key === "liquidity"));

  // A latest period over 15 months old says how old it is, beside the data's other limits.
  const stalePeriod = useMemo(
    () => stalePeriodNote(financialStatementPeriods(displayStatements, subTab)),
    [displayStatements, subTab],
  );
  const notInYetLine = useMemo(
    () => notInYetNote(notInYet, subTab, resolvedPeriod, yearEndMonth),
    [notInYet, resolvedPeriod, subTab, yearEndMonth],
  );
  usePaneNoticeFooter({
    registrationId: "financials-notices",
    notices: [
      ...(notInYetLine ? [notInYetLine] : []),
      ...exchangeResults,
      ...(stalePeriod ? [stalePeriod] : []),
      ...(filledPeriods ? [filledPeriods] : []),
      ...financialStatementLimitations(financials),
      ...(offeringNote ? [offeringNote] : []),
      ...(isValuation && history.error && !history.data ? ["Period-end prices are unavailable, so valuation ratios are too."] : []),
      ...(isValuation ? [currencies?.warning(displayStatements) ?? ""] : []),
    ],
    focused,
  });

  // A null snapshot is still in flight; only a loaded one can say "no coverage".
  if (!financials || (!hasAnnualStatements && !hasQuarterlyStatements)) {
    return (
      <PaneStatusBody
        loading={!financials}
        empty={!!financials}
        subject="financials"
        emptyTitle="No financial statements."
        emptyMessage="This ticker has no annual or quarterly statement coverage."
      />
    );
  }

  const asOf = periodEnd ? `as of ${periodEnd}` : undefined;
  // The as-of is the bar's own segment, which keeps its place when the pane is narrow; the context after it gives way.
  const queryBar = (meta: string) => (
    <QueryBar
      width={Math.max(1, width - 2)}
      filters={[
        // The ratio tabs sit behind one Ratios segment, so the statement strip
        // keeps its width; the open ratio tab is picked beside it.
        { id: "statement", label: "Statement", inline: true,
          value: ratioTab ? RATIOS_SEGMENT : section.key,
          options: [
            ...FINANCIAL_SUB_TABS.map((tab) => ({ label: tab.name, value: tab.key })),
            { label: "Ratios", value: RATIOS_SEGMENT },
          ],
          onChange: (value: string) => selectSection(value === RATIOS_SEGMENT ? lastRatioKey : value) },
        ...(ratioTab ? [{ id: "ratio", label: "Ratio",
          value: ratioTab.key,
          options: RATIO_TABS.map((tab) => ({ label: tab.name, value: tab.key })),
          onChange: selectSection }] : []),
      ]}
      view={{
        value: isAnnual ? "annual" : "quarterly",
        options: [
          { label: "Annual", value: "annual", disabled: !hasAnnualStatements },
          { label: "Quarterly", value: "quarterly", disabled: !hasQuarterlyStatements },
        ],
        onChange: (value: string) => setPeriod(value as FinancialPeriod),
      }}
      asOf={asOf}
      meta={meta || undefined}
    />
  );

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      // Desktop: the query bar and table run edge to edge like every other
      // pane; the table keeps its own inline padding.
      paddingX={nativePaneChrome ? 0 : 1}
      overflow="hidden"
    >
      {isValuation && oldestPeriodEnd ? <PeriodEndHistoryLoader oldestPeriodEnd={oldestPeriodEnd} onChange={setHistory} /> : null}
      {ratioModel ? (
        <RatioTable
          focused={focused}
          model={ratioModel}
          columns={ratioColumns}
          headerScrollRef={headerScrollRef}
          bodyScrollRef={bodyScrollRef}
          syncHeaderScroll={syncHeaderScroll}
          headerScrollId={headerScrollId}
          bodyScrollId={bodyScrollId}
          onToggle={toggleGroup}
          exportMetadata={() => [
            ["Currency", comparisonCurrency ?? "per column"],
            ...(periodEnd ? [["As of", periodEnd]] : []),
          ]}
          resetScrollKey={`${resolvedPeriod}:${section.key}:${displayStatements.length}`}
          rootBefore={queryBar(comparisonCurrency ?? "")}
        />
      ) : (
        <DataTableView<FinancialTableRow, FinancialTableColumn>
          focused={focused}
          headerScrollRef={headerScrollRef}
          scrollRef={bodyScrollRef}
          syncHeaderScroll={syncHeaderScroll}
          headerScrollId={headerScrollId}
          bodyScrollId={bodyScrollId}
          columns={columns}
          // Fiscal periods, oldest to newest: an axis, not columns to arrange.
          columnReorder={false}
          items={rows}
          selection={{
            kind: "id",
            selectedId: selectedRowId,
            getId: (row) => row.id,
            onChange: (_id, row, _index, reason) => {
              setSelectedRowId(row.id);
              if (reason === "pointer" && row.kind === "group" && row.toggleable) {
                toggleGroup(row.id);
              }
            },
          }}
          sortColumnId={null}
          sortDirection="desc"
          getItemKey={financialRowKey}
          onActivate={(row) => {
            if (row.kind === "group" && row.toggleable) toggleGroup(row.id);
          }}
          getRowBackgroundColor={financialRowBackground}
          renderCell={renderCell}
          emptyStateTitle="No financial data"
          getExportMetadata={() => [
            ["Currency", comparisonCurrency ?? "per column"],
            ...(unit ? [["Unit", unit]] : []),
            ["Growth", growthBasis],
            ...(periodEnd ? [["As of", periodEnd]] : []),
          ]}
          showHorizontalScrollbar
          resetScrollKey={`${resolvedPeriod}:${subTab.key}:${displayStatements.length}`}
          rootBefore={queryBar(growthBasis ?? "")}
        />
      )}
    </Box>
  );
}
