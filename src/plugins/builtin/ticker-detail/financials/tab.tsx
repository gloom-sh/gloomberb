import { formatDay } from "../../../../utils/day-format";
import { Box, Text, useUiCapabilities } from "../../../../ui";
import { TextAttributes, type ScrollBoxRenderable } from "../../../../ui";
import { useShortcut } from "../../../../react/input";
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { usePaneStateValue, usePaneTicker } from "../../../../state/app/context";
import {
  DataTableView,
  DisclosureMarker,
  Notice,
  PaneLinkMenu,
  PaneStatusBody,
  QueryBar,
  usePaneFooter,
  usePaneNoticeFooter,
  type DataTableCell,
  type DataTableColumn,
} from "../../../../components";
import { colors, priceColor } from "../../../../theme/colors";
import { notMeaningfulColor } from "../../../../components/ui/not-meaningful";
import { isNotMeaningful } from "../../../../utils/growth";
import { useRemoteUiNode } from "../../../../remote/semantic-tree";
import { fiscalYearEndMonth } from "../../../../utils/fiscal-period";
import { displayWidth } from "../../../../utils/format";
import { filledPeriodPublications, filledPeriodsNote, stalePeriodNote } from "../../../../utils/financial-statements";
import {
  FINANCIAL_COL_W,
  financialLabelWidth,
  financialPeriodWidth,
  FINANCIAL_SUB_TABS,
  buildFinancialRows,
  collectDefaultCollapsedGroupIds,
  collectGroupIds,
  financialCellParts,
  financialColumnName,
  financialColumnPeriod,
  financialGrowthNotice,
  financialPeriodEnd,
  financialPeriodFiling,
  financialPeriodHeaderLabel,
  formatFinancialCell,
  formatFinancialCellValue,
  financialStatementBasisNote,
  financialStatementCurrency,
  financialStatementLimitations,
  financialStatementPeriods,
  financialSubTabFields,
  latestFinancialPeriodEnd,
  notInYetNote,
  trailingNotInYetNote,
  resolveFinancialPeriod,
  resolveFinancialPeriodOption,
  semanticGrowthValue,
  selectFinancialStatements,
  shareFinancialUnit,
  type FinancialPeriod,
  type FinancialTableRow,
} from "./model";
import type { FinancialTableStatement } from "./aggregation";
import {
  FINANCIAL_SECTIONS,
  RATIO_TABS,
  blankRatioPeriodsNote,
  buildRatioTableModel,
  latestRunwayPeriodEnd,
  oldestRatioPeriodEnd,
  periodEndClose,
  ratioOpenings,
  ratioPeriodEnd,
  ratioPeriods,
  resolveFinancialSectionKey,
  visibleRatios,
  type RatioAmount,
} from "./ratios";
import {
  PERIOD_END_NAME_CELL,
  PERIOD_END_ROW,
  PeriodEndHistoryLoader,
  RatioTable,
  periodEndCell,
  ratioMetricColumn,
  type PeriodEndHistoryState,
  type PeriodEndRow,
  type RatioTableColumn,
} from "./ratio-table";
import { useExchangeResultsNotes } from "./exchange-results";
import { ExchangeStatementTable } from "./exchange-table";
import { latestBalanceSheetDate, useOfferingNote, useRunwayOfferings } from "./offerings";
import { burnsCash, cashRunway, runwayOfferingNote } from "../../../../utils/cash-runway";
import { useBoundTicker } from "../../shared/ticker-request";
import { createValuationCurrencyContext } from "../../../../time-series/valuation-currency";

const RATIOS_SEGMENT = "ratios";
type FinancialView = FinancialPeriod | "exchange";

type FinancialTableColumn = DataTableColumn & (
  | { id: "metric"; kind: "metric" }
  | { id: string; kind: "statement"; statement: FinancialTableStatement; filingUrl?: string; /** The table's last column. */ last: boolean }
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
/** The statement's lines under the day each period ends. */
type StatementTableRow = FinancialTableRow | PeriodEndRow;

const financialRowKey = (row: StatementTableRow) => row.id;
const financialRowBackground = (row: StatementTableRow) => (
  row.kind === "group" && row.depth === 0 ? colors.panel : undefined
);
const isStatementLine = (row: StatementTableRow) => row.kind !== "period-end";

/** The fiscal period, plus the column's currency when the table has no single one. The day it ends is the first row. */
function financialColumnHeader(
  statement: FinancialTableStatement,
  kind: FinancialPeriod,
  yearEndMonth: number | null,
  sharedCurrency: string | undefined,
): string {
  const header = financialColumnName(statement, kind, yearEndMonth);
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
  const [storedPeriod, setStoredPeriod] = usePaneStateValue<FinancialView>("financialPeriod", fallbackPeriod);
  const period = resolveFinancialPeriodOption(storedPeriod) ?? fallbackPeriod;
  const [storedSubTab, setStoredSubTab] = usePaneStateValue<string>("financialSubTab", FINANCIAL_SUB_TABS[0]!.key);
  const resolvedSubTabKey = resolveFinancialSectionKey(storedSubTab);
  const subTabIdx = Math.max(0, FINANCIAL_SECTIONS.findIndex((tab) => tab.key === resolvedSubTabKey));
  // Ratios open collapsed: the inputs behind each one show on demand. A capture of a ratio tab opens them all
  // (`financialRatiosExpanded`), so the picture holds the inputs the report lists.
  const [ratiosExpanded] = usePaneStateValue<boolean>("financialRatiosExpanded", false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set([
    ...collectDefaultCollapsedGroupIds(FINANCIAL_SUB_TABS.flatMap((tab) => tab.rows)),
    ...ratiosExpanded ? [] : RATIO_TABS.flatMap((tab) => tab.ratios.map((ratio) => ratio.id)),
  ]));
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const bodyScrollRef = useRef<ScrollBoxRenderable>(null);
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);
  const { nativePaneChrome } = useUiCapabilities();
  const section = FINANCIAL_SECTIONS[subTabIdx]!;
  const ratioTab = section.kind === "ratio" ? section.tab : null;
  // A ratio tab builds its own rows; the statement rows below idle on Income.
  const subTab = section.kind === "statement" ? section.tab : FINANCIAL_SUB_TABS[0]!;
  const exchangeStatements = useMemo(() => ratioTab ? [] : (financials?.taiwanExchangeStatements ?? [])
    .filter((statement) => statement.kind === subTab.key)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)), [financials?.taiwanExchangeStatements, ratioTab, subTab.key]);
  const [exchangePeriod, setExchangePeriod] = usePaneStateValue<string>("financialExchangePeriod", "");
  const exchangeStatement = exchangeStatements.find((statement) => statement.periodEnd === exchangePeriod)
    ?? exchangeStatements[0];
  const showExchange = !!exchangeStatement && (storedPeriod === "exchange" || (!hasAnnualStatements && !hasQuarterlyStatements));
  // A ratio read over one quarter is not on the annual view, so its state does not count there.
  const quarterlyView = resolveFinancialPeriod(period, hasAnnualStatements, hasQuarterlyStatements) === "quarterly";
  const currentGroupIds = useMemo(
    () => ratioTab ? visibleRatios(ratioTab, quarterlyView).map((ratio) => ratio.id) : collectGroupIds(subTab.rows),
    [quarterlyView, ratioTab, subTab],
  );
  const hasCollapsedCurrentGroup = !showExchange && currentGroupIds.some((id) => collapsedGroups.has(id));
  const hasExpandedCurrentGroup = !showExchange && currentGroupIds.some((id) => !collapsedGroups.has(id));
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
  const views = useMemo(() => [
    { label: "Annual", value: "annual" as const, disabled: !hasAnnualStatements },
    { label: "Quarterly", value: "quarterly" as const, disabled: !hasQuarterlyStatements },
    ...(exchangeStatement ? [{ label: "Exchange", value: "exchange" as const, disabled: false }] : []),
  ], [hasAnnualStatements, hasQuarterlyStatements, !!exchangeStatement]);
  const resolvedPeriod = resolveFinancialPeriod(period, hasAnnualStatements, hasQuarterlyStatements);
  const activeView = showExchange ? "exchange" : resolvedPeriod;
  const canTogglePeriod = views.filter((view) => !view.disabled).length > 1;
  const togglePeriod = useCallback(() => {
    const options = views.filter((view) => !view.disabled);
    const next = options[(options.findIndex(({ value }) => value === activeView) + 1) % options.length];
    if (next) setStoredPeriod(next.value);
  }, [activeView, setStoredPeriod, views]);
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
        disabled: !canTogglePeriod,
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
    canTogglePeriod,
    collapseCurrentGroups,
    expandCurrentGroups,
    financials,
    hasCollapsedCurrentGroup,
    hasExpandedCurrentGroup,
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
    if (storedPeriod === "exchange") return;
    if (period === "annual" && !hasAnnualStatements && hasQuarterlyStatements) {
      setStoredPeriod("quarterly");
    } else if (period === "quarterly" && !hasQuarterlyStatements && hasAnnualStatements) {
      setStoredPeriod("annual");
    }
  }, [hasAnnualStatements, hasQuarterlyStatements, period, setStoredPeriod, storedPeriod]);

  const isAnnual = resolvedPeriod === "annual";
  const selected = useMemo(
    () => selectFinancialStatements(resolvedPeriod, subTab.key, annualStatements, quarterlyStatements, undefined, financials?.trailingStatement),
    [annualStatements, quarterlyStatements, resolvedPeriod, subTab.key, financials?.trailingStatement],
  );
  // A newest period with only some figures (an EPS alone) is left out of the columns, and a line says so, as it
  // does of a newer quarter the TTM passed over.
  const { statements: displayStatements, notInYet, trailingNotInYet } = selected;
  const previousStatementMap = selected.previousStatementMap;
  // One currency for every column goes in the query bar with the growth basis;
  // a column in a different currency (or none) says so in its own header.
  const growthBasis = isAnnual ? "YoY" : "QoQ";
  useRemoteUiNode(!showExchange && !ratioTab && displayStatements.length ? {
    role: "report-notice",
    label: "Growth",
    getMetadata: () => ({ text: financialGrowthNotice(resolvedPeriod, displayStatements), key: "growthBasis", value: growthBasis }),
  } : null);
  const yearEndMonth = useMemo(() => fiscalYearEndMonth(annualStatements), [annualStatements]);
  const annualDates = useMemo(() => new Set(annualStatements.map(({ date }) => date)), [annualStatements]);
  const periodFilings = financials?.periodFilings;
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
    financialColumnPeriod(statement, resolvedPeriod, annualDates),
    yearEndMonth,
    comparisonCurrency,
  )), [annualDates, comparisonCurrency, displayStatements, resolvedPeriod, yearEndMonth]);
  // The day each period ends: the table's first row, under the fiscal period that heads the column.
  const periodEnds = useMemo(() => displayStatements.map((statement) => financialPeriodEnd(statement) ?? ""), [displayStatements]);
  const datedPeriods = periodEnds.some(Boolean);
  // A period is as wide as its widest value and growth, so each pair sits as far from the next as from its own
  // growth and more periods fit; its header and its end date fit too. The ratio tabs keep their fixed width. Every
  // line of the statement counts, a collapsed group's too, so opening or closing one leaves the periods where they
  // are.
  const periodWidth = useMemo(() => {
    if (ratioTab) return Math.max(FINANCIAL_COL_W, financialPeriodWidth([], periodHeaders, periodEnds.map((end) => end && formatDay(end))));
    const everyRow = shareFinancialUnit(buildFinancialRows(subTab.rows, displayStatements, NO_COLLAPSED_GROUPS)).rows;
    const values = [...everyRow, ...rows].flatMap((row) => displayStatements.map((statement) => (
      formatFinancialCellValue(row, statement)
    )));
    return financialPeriodWidth(values, periodHeaders, periodEnds.map((end) => end && formatDay(end)));
  }, [displayStatements, periodEnds, periodHeaders, ratioTab, rows, subTab.rows]);
  const tableRows = useMemo<StatementTableRow[]>(() => datedPeriods ? [PERIOD_END_ROW, ...rows] : rows, [datedPeriods, rows]);
  const columns = useMemo<FinancialTableColumn[]>(() => [
    {
      id: "metric",
      kind: "metric",
      label: metricHeader,
      width: financialLabelWidth(width, periodWidth, displayStatements.length, nativePaneChrome),
      align: "left",
    },
    ...displayStatements.map((statement, index): FinancialTableColumn => ({
      id: `statement:${statement.date}:${index}`,
      kind: "statement",
      statement,
      filingUrl: financialPeriodFiling(periodFilings, statement, financialColumnPeriod(statement, resolvedPeriod, annualDates))?.url,
      last: index === displayStatements.length - 1,
      label: financialPeriodHeaderLabel(periodHeaders[index]!, periodWidth),
      width: periodWidth,
      align: "right",
      headerColor: statement.date === "TTM" ? colors.textBright : colors.textDim,
    })),
  ], [annualDates, displayStatements, metricHeader, nativePaneChrome, periodFilings, periodHeaders, periodWidth, resolvedPeriod, width]);
  const periodEnd = latestFinancialPeriodEnd(displayStatements);
  const renderCell = useCallback((
    row: StatementTableRow,
    column: FinancialTableColumn,
  ): DataTableCell => {
    if (row.kind === "period-end") {
      if (column.kind === "metric") return PERIOD_END_NAME_CELL;
      return periodEndCell(financialPeriodEnd(column.statement), column.width, nativePaneChrome || column.last, column.filingUrl);
    }
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

    const { formattedValue, growth } = financialCellParts(row, column.statement, previousStatementMap.get(column.statement.date), comparisonCurrency);
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
            // N/M growth as every pane draws it.
            fg={growthColorValue != null ? priceColor(growthColorValue) : isNotMeaningful(growth) ? notMeaningfulColor() : colors.text}
          >
            {cell.growthText}
          </Text>
        </Box>
      ),
    };
  }, [comparisonCurrency, nativePaneChrome, previousStatementMap, toggleGroup]);
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
  const currencies = useMemo(() => financials ? createValuationCurrencyContext(financials, history.fx) : null, [financials, history.fx]);
  const valuationFxCurrencies = isValuation ? currencies?.fxCurrencies(displayStatements).sort().join(",") ?? "" : "";
  const { symbol: boundSymbol, exchange: boundExchange } = useBoundTicker();
  const latestRunway = financials && ratioTab?.key === "liquidity" ? cashRunway(financials) : null;
  const runwayPeriodEnd = burnsCash(latestRunway) ? latestRunway.periodEnd : null;
  const runwayFilings = useRunwayOfferings(boundSymbol, boundExchange, runwayPeriodEnd);
  const ratioModel = useMemo(() => {
    if (!ratioTab) return null;
    const openings = ratioOpenings(resolvedPeriod, annualStatements, quarterlyStatements, displayStatements.find((statement) => statement.date === "TTM"));
    const price = (statement: FinancialTableStatement): RatioAmount => {
      if (!isValuation) return "no-price";
      if (!history.data) return history.error && !history.loading ? "no-price" : "loading";
      const date = ratioPeriodEnd(statement);
      const close = periodEndClose(history.data, date);
      return (close === undefined ? null : currencies?.priceInStatementUnits(statement, close, date)) ?? "no-price";
    };
    const expanded = new Set(ratioTab.ratios.map((ratio) => ratio.id).filter((id) => !collapsedGroups.has(id)));
    return buildRatioTableModel(ratioTab, ratioPeriods(displayStatements, openings, resolvedPeriod, price, { annual: annualStatements, quarterly: quarterlyStatements }), expanded, financials?.profile,
      runwayPeriodEnd ? { periodEnd: runwayPeriodEnd, filings: runwayFilings } : undefined);
  }, [
    annualStatements, collapsedGroups, currencies, displayStatements, history.data, history.error, history.loading,
    isValuation, quarterlyStatements, ratioTab, resolvedPeriod, financials?.profile, runwayPeriodEnd, runwayFilings,
  ]);
  // The model's periods: a column the tab has nothing for is left out of it (buildRatioTableModel).
  const ratioColumns = useMemo<RatioTableColumn[]>(() => [
    ratioMetricColumn(width),
    ...(ratioModel?.periods ?? []).flatMap(({ statement }, index) => columns.flatMap((column) => (
      column.kind === "statement" && column.statement === statement ? [{ ...column, index }] : []
    ))),
  ], [columns, ratioModel, width]);

  // The Balance Sheet and Liquidity show cash, which an offering filed since the latest balance sheet is not in yet.
  // Years filled from the listing's exchange, with the lines this table shows.
  const filledFields = useMemo(() => ratioTab ? undefined : financialSubTabFields(subTab), [ratioTab, subTab]);
  const filledPeriods = useMemo(() => filledPeriodsNote(displayStatements, filledFields), [displayStatements, filledFields]);
  const filledDates = useMemo(() => filledPeriodPublications(displayStatements, filledFields), [displayStatements, filledFields]);
  // An HKEX company's latest period dated by its results announcement, unless the filled periods already date it, and
  // what was announced after it.
  const exchangeResults = useExchangeResultsNotes(boundSymbol, boundExchange, latestBalanceSheetDate(financials), filledDates);
  const balanceOfferingNote = useOfferingNote(boundSymbol, boundExchange, latestBalanceSheetDate(financials), !!financials && section.key === "balance");
  const historicalOfferingNote = useOfferingNote(boundSymbol, boundExchange, latestRunwayPeriodEnd(ratioModel), !latestRunway && section.key === "liquidity");
  const offeringNote = runwayPeriodEnd ? runwayOfferingNote(runwayFilings, runwayPeriodEnd, latestRunway?.currency) : balanceOfferingNote ?? historicalOfferingNote;

  // A latest period over 15 months old says how old it is, beside the data's other limits.
  const stalePeriod = useMemo(
    () => stalePeriodNote(financialStatementPeriods(displayStatements, subTab)),
    [displayStatements, subTab],
  );
  const notInYetLine = useMemo(
    () => notInYetNote(notInYet, subTab, resolvedPeriod, yearEndMonth)
      ?? trailingNotInYetNote(displayStatements, trailingNotInYet, subTab, yearEndMonth),
    [displayStatements, notInYet, resolvedPeriod, subTab, trailingNotInYet, yearEndMonth],
  );
  const blankRatioLine = ratioModel ? blankRatioPeriodsNote(ratioModel, resolvedPeriod, yearEndMonth) : null;
  usePaneNoticeFooter({
    registrationId: "financials-notices",
    notices: showExchange ? [] : [
      ...(notInYetLine ? [notInYetLine] : []),
      ...(blankRatioLine ? [blankRatioLine] : []),
      ...exchangeResults,
      ...(stalePeriod ? [stalePeriod] : []),
      ...(filledPeriods ? [filledPeriods] : []),
      ...financialStatementLimitations(financials),
      ...(offeringNote ? [offeringNote] : []),
      ...(isValuation && history.error && !history.data ? ["Period-end prices are unavailable, so valuation ratios are too."] : []),
      ...(isValuation && !history.loading ? [currencies?.conversionNote(displayStatements, ratioPeriodEnd) ?? "", currencies?.warning(displayStatements, ratioPeriodEnd) ?? ""] : []),
    ],
    focused,
  });

  // A null snapshot is still in flight; only a loaded one can say "no coverage".
  if (!financials || (!hasAnnualStatements && !hasQuarterlyStatements && !financials.taiwanExchangeStatements?.length)) {
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

  // A scoped series says what it is filed as, and a newer filing under review, under the bar at every width: the bar's
  // meta gives way first and would cut it. Statements with no scope keep their meta as it was.
  const basisNote = financialStatementBasisNote(financials);
  const pendingReview = !basisNote && financials.statementReview?.status === "pending" ? "New filing under review" : undefined;
  const queryBar = (meta: string) => (<>
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
        ...(showExchange && exchangeStatement && exchangeStatements.length > 1 ? [{
          id: "exchange-period", label: "Period ending", value: exchangeStatement.periodEnd,
          options: exchangeStatements.map(({ periodEnd }) => ({ label: formatDay(periodEnd), value: periodEnd })),
          onChange: setExchangePeriod,
        }] : []),
      ]}
      view={{
        value: activeView,
        options: views,
        onChange: (value: string) => setStoredPeriod(value as FinancialView),
      }}
      meta={[showExchange ? undefined : pendingReview, meta].filter(Boolean).join(" · ") || undefined}
    />
    {/* Lined up with the bar's text and the table's; on the desktop the notice takes the pane's inset itself. */}
    {basisNote && !showExchange ? <Box flexShrink={0} paddingX={nativePaneChrome ? 0 : 1}><Notice tone="muted">{basisNote}</Notice></Box> : null}
  </>);

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
      {isValuation && oldestPeriodEnd ? <PeriodEndHistoryLoader oldestPeriodEnd={oldestPeriodEnd} fxCurrencies={valuationFxCurrencies} onChange={setHistory} /> : null}
      {showExchange && exchangeStatement ? (
        <ExchangeStatementTable focused={focused} statement={exchangeStatement} width={width} queryBar={queryBar("")} />
      ) : ratioModel ? (
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
            ...(financials.statementScope ? [["Statement basis", financials.statementScope.label]] : []),
            ["Currency", comparisonCurrency ?? "per column"],
            ...(periodEnd ? [["As of", periodEnd]] : []),
          ]}
          resetScrollKey={`${resolvedPeriod}:${section.key}:${displayStatements.length}`}
          rootBefore={queryBar(comparisonCurrency ?? "")}
        />
      ) : (<PaneLinkMenu>
        <DataTableView<StatementTableRow, FinancialTableColumn>
          focused={focused}
          headerScrollRef={headerScrollRef}
          scrollRef={bodyScrollRef}
          syncHeaderScroll={syncHeaderScroll}
          headerScrollId={headerScrollId}
          bodyScrollId={bodyScrollId}
          columns={columns}
          // Fiscal periods, oldest to newest: an axis, not columns to arrange.
          columnReorder={false}
          items={tableRows}
          // The cursor walks the statement's lines; the period ends are part of the heading.
          isNavigable={isStatementLine}
          selection={{
            kind: "id",
            selectedId: selectedRowId,
            getId: (row) => row.id,
            onChange: (_id, row, _index, reason) => {
              if (row.kind === "period-end") return;
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
            ...(financials.statementScope ? [["Statement basis", financials.statementScope.label]] : []),
            ["Currency", comparisonCurrency ?? "per column"],
            ...(unit ? [["Unit", unit]] : []),
            ["Growth", growthBasis],
            ...(periodEnd ? [["As of", periodEnd]] : []),
            ...columns.flatMap((column) => column.kind === "statement" && column.filingUrl
              ? [[`Issuer filing for ${financialPeriodEnd(column.statement)}`, column.filingUrl]] : []),
          ]}
          showHorizontalScrollbar
          resetScrollKey={`${resolvedPeriod}:${subTab.key}:${displayStatements.length}`}
          rootBefore={queryBar(growthBasis ?? "")}
        />
      </PaneLinkMenu>)}
    </Box>
  );
}
