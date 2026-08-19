import { Box, Text, useUiCapabilities } from "../../../../ui";
import { TextAttributes, type ScrollBoxRenderable } from "../../../../ui";
import { useShortcut } from "../../../../react/input";
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { usePaneStateValue, usePaneTicker } from "../../../../state/app/context";
import {
  DataTableView,
  PaneStatusBody,
  Tabs,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
} from "../../../../components";
import { colors, priceColor } from "../../../../theme/colors";
import type { FinancialStatement } from "../../../../types/financials";
import { padTo } from "../../../../utils/format";
import {
  FINANCIAL_COL_W,
  FINANCIAL_LABEL_W,
  FINANCIAL_PERIOD_TABS_WIDTH,
  FINANCIAL_SUB_TABS,
  FINANCIAL_SUB_TABS_WIDTH,
  buildFinancialRows,
  buildPreviousStatementMap,
  collectDefaultCollapsedGroupIds,
  collectGroupIds,
  computeGrowth,
  computeTTM,
  formatFinancialCell,
  formatFinancialHeader,
  formatFinancialValue,
  resolveFinancialPeriod,
  resolveFinancialPeriodOption,
  resolveFinancialSubTabKey,
  semanticGrowthValue,
  statementMetricValue,
  type FinancialPeriod,
  type FinancialTableRow,
} from "./model";

type FinancialTableColumn = DataTableColumn & (
  | { id: "metric"; kind: "metric" }
  | { id: string; kind: "statement"; statement: FinancialStatement }
);

export function FinancialsTab({
  focused,
  headerScrollId,
  bodyScrollId,
  allowArrowSubTabNavigation = true,
}: {
  focused: boolean;
  headerScrollId?: string;
  bodyScrollId?: string;
  allowArrowSubTabNavigation?: boolean;
}) {
  const { financials } = usePaneTicker();
  return (
    <ResolvedFinancialsTab
      focused={focused}
      financials={financials}
      headerScrollId={headerScrollId}
      bodyScrollId={bodyScrollId}
      allowArrowSubTabNavigation={allowArrowSubTabNavigation}
    />
  );
}

export function ResolvedFinancialsTab({
  focused,
  financials,
  headerScrollId,
  bodyScrollId,
  allowArrowSubTabNavigation = true,
}: {
  focused: boolean;
  financials: ReturnType<typeof usePaneTicker>["financials"];
  headerScrollId?: string;
  bodyScrollId?: string;
  allowArrowSubTabNavigation?: boolean;
}) {
  const annualStatements = financials?.annualStatements ?? [];
  const quarterlyStatements = financials?.quarterlyStatements ?? [];
  const hasAnnualStatements = annualStatements.length > 0;
  const hasQuarterlyStatements = quarterlyStatements.length > 0;
  const fallbackPeriod: FinancialPeriod = hasAnnualStatements ? "annual" : "quarterly";
  const [storedPeriod, setStoredPeriod] = usePaneStateValue<FinancialPeriod>("financialPeriod", fallbackPeriod);
  const period = resolveFinancialPeriodOption(storedPeriod) ?? fallbackPeriod;
  const [storedSubTab, setStoredSubTab] = usePaneStateValue<string>("financialSubTab", FINANCIAL_SUB_TABS[0]!.key);
  const resolvedSubTabKey = resolveFinancialSubTabKey(storedSubTab);
  const subTabIdx = Math.max(0, FINANCIAL_SUB_TABS.findIndex((tab) => tab.key === resolvedSubTabKey));
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(collectDefaultCollapsedGroupIds(FINANCIAL_SUB_TABS.flatMap((tab) => tab.rows))),
  );
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const bodyScrollRef = useRef<ScrollBoxRenderable>(null);
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);
  const { nativePaneChrome } = useUiCapabilities();
  const subTab = FINANCIAL_SUB_TABS[subTabIdx]!;
  const currentGroupIds = useMemo(() => collectGroupIds(subTab.rows), [subTab]);
  const hasCollapsedCurrentGroup = currentGroupIds.some((id) => collapsedGroups.has(id));
  const hasExpandedCurrentGroup = currentGroupIds.some((id) => !collapsedGroups.has(id));
  const setPeriod = useCallback((next: SetStateAction<FinancialPeriod>) => {
    setStoredPeriod(next);
  }, [setStoredPeriod]);
  const setSubTabIdx = useCallback((next: SetStateAction<number>) => {
    setStoredSubTab((currentKey) => {
      const currentSubTabKey = resolveFinancialSubTabKey(currentKey);
      const currentIndex = Math.max(0, FINANCIAL_SUB_TABS.findIndex((tab) => tab.key === currentSubTabKey));
      const rawIndex = typeof next === "function" ? next(currentIndex) : next;
      const boundedIndex = ((rawIndex % FINANCIAL_SUB_TABS.length) + FINANCIAL_SUB_TABS.length) % FINANCIAL_SUB_TABS.length;
      return FINANCIAL_SUB_TABS[boundedIndex]?.key ?? FINANCIAL_SUB_TABS[0]!.key;
    });
  }, [setStoredSubTab]);
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
        key: "1-3",
        label: "section",
        disabled: !financials,
        onPress: () => setSubTabIdx((current) => (current + 1) % FINANCIAL_SUB_TABS.length),
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
    } else if (keyName === "1" || keyName === "2" || keyName === "3") {
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
  const rawStatements = isAnnual
    ? annualStatements.slice(-5).reverse()
    : quarterlyStatements.slice(-6).reverse();
  const ttm = isAnnual ? computeTTM(quarterlyStatements) : null;
  const displayStatements = ttm ? [ttm, ...rawStatements] : rawStatements;
  const previousStatementMap = buildPreviousStatementMap(
    resolvedPeriod,
    annualStatements,
    quarterlyStatements,
    ttm,
  );
  const columns: FinancialTableColumn[] = [
    {
      id: "metric",
      kind: "metric",
      label: isAnnual ? "Annual" : "Quarterly",
      width: FINANCIAL_LABEL_W,
      align: "left",
    },
    ...displayStatements.map((statement, index): FinancialTableColumn => ({
      id: `statement:${statement.date}:${index}`,
      kind: "statement",
      statement,
      label: padTo(formatFinancialHeader(statement.date), FINANCIAL_COL_W, "center"),
      width: FINANCIAL_COL_W,
      align: "right",
      headerColor: statement.date === "TTM" ? colors.textBright : colors.textDim,
    })),
  ];
  const rows = buildFinancialRows(subTab.rows, displayStatements, collapsedGroups);
  useEffect(() => {
    if (rows.length === 0) {
      if (selectedRowId !== null) setSelectedRowId(null);
      return;
    }
    if (selectedRowId && rows.some((row) => row.id === selectedRowId)) return;
    setSelectedRowId(rows[0]!.id);
  }, [rows, selectedRowId]);

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

  const renderCell = (
    row: FinancialTableRow,
    column: FinancialTableColumn,
  ): DataTableCell => {
    if (column.kind === "metric") {
      if (row.kind === "group") {
        const indent = " ".repeat(row.depth * 2);
        const marker = row.toggleable ? (row.expanded ? "▾" : "▸") : " ";
        return {
          text: `${indent}${marker} ${row.unitLabel}`,
          color: row.depth === 0 ? colors.textBright : colors.textDim,
          attributes: row.depth === 0 ? TextAttributes.BOLD : TextAttributes.NONE,
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

    const key = row.kind === "group" ? row.summaryKey : undefined;
    if (row.kind === "group" && !key) return {
      text: "",
    };

    const previous = previousStatementMap.get(column.statement.date);
    const value = row.kind === "group"
      ? column.statement[key!] as number | undefined
      : statementMetricValue(row, column.statement);
    const previousValue = previous
      ? row.kind === "group"
        ? previous[key!] as number | undefined
        : statementMetricValue(row, previous)
      : undefined;
    const growth = row.kind === "metric" && !row.showGrowth ? undefined : computeGrowth(value, previousValue);
    const formattedValue = formatFinancialValue(value, row);
    const cell = formatFinancialCell(formattedValue, growth);
    const growthColorValue = semanticGrowthValue(growth, row.growthDirection);

    return {
      text: `${cell.valueText}${cell.growthText}`,
      content: (
        <Box flexDirection="row" width={FINANCIAL_COL_W}>
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
  };

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      paddingX={1}
      paddingBottom={nativePaneChrome ? 0 : 1}
      overflow="hidden"
    >
      <DataTableView<FinancialTableRow, FinancialTableColumn>
        focused={focused}
        headerScrollRef={headerScrollRef}
        scrollRef={bodyScrollRef}
        syncHeaderScroll={syncHeaderScroll}
        headerScrollId={headerScrollId}
        bodyScrollId={bodyScrollId}
        columns={columns}
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
        onHeaderClick={() => {}}
        getItemKey={(row) => row.id}
        onActivate={(row) => {
          if (row.kind === "group" && row.toggleable) toggleGroup(row.id);
        }}
        getRowBackgroundColor={(row) => row.kind === "group" && row.depth === 0 ? colors.panel : undefined}
        renderCell={renderCell}
        emptyStateTitle="No financial data"
        showHorizontalScrollbar
        resetScrollKey={`${resolvedPeriod}:${subTab.key}:${displayStatements.length}`}
        rootBefore={(
          <>
            <Box flexDirection="row" height={1}>
              <Box width={FINANCIAL_SUB_TABS_WIDTH} height={1}>
                <Tabs
                  tabs={FINANCIAL_SUB_TABS.map((tab, index) => ({
                    label: tab.name,
                    value: String(index),
                  }))}
                  activeValue={String(subTabIdx)}
                  onSelect={(value) => setSubTabIdx(Number(value))}
                  compact
                  variant="bare"
                />
              </Box>
              <Box flexGrow={1} />
              <Box width={FINANCIAL_PERIOD_TABS_WIDTH} height={1}>
                <Tabs
                  tabs={[
                    { label: "Annual", value: "annual", disabled: !hasAnnualStatements },
                    { label: "Quarterly", value: "quarterly", disabled: !hasQuarterlyStatements },
                  ]}
                  activeValue={isAnnual ? "annual" : "quarterly"}
                  onSelect={(value) => setPeriod(value as FinancialPeriod)}
                  compact
                  variant="bare"
                />
              </Box>
            </Box>
          </>
        )}
      />
    </Box>
  );
}
