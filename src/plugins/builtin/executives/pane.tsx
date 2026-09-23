import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CloudExecutiveRowPayload,
  CloudProxyStatementPayload,
} from "../../../api-client";
import {
  DataTableView,
  EmptyState, PaneStatusBody, Prose, QueryBar, SectionHeading,
  Tabs,
  usePaneFooter,
  usePaneHeaderTabs,
  usePaneNoticeFooter,
  type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment,
  type PaneHint,
  type QueryBarFilter,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { useAsyncResource } from "../../../react/async-resource";
import { usePaneStateValue } from "../../../state/app/context";
import { colors, getChartIndicatorColor } from "../../../theme/colors";
import {
  Box,
  ScrollBox,
  Text,
  TextAttributes,
  useRendererHost,
  useUiCapabilities,
  useUiHost,
  type ScrollBoxRenderable,
} from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { useBoundTicker } from "../shared/ticker-request";
import { discardProxyData, loadProxyStatement, loadProxyStatements } from "./data";
import {
  equityShare,
  formatChange,
  formatFiled,
  formatPay,
  formatRatio,
} from "./format";

export const EXECUTIVES_PANE_ID = "executives";

const MAX_PROSE_WIDTH = 100;

function retainedDataNotice(subject: string, error: string, fetchedAt: number | null): string {
  const retrieved = new Date(fetchedAt ?? Number.NaN);
  const age = Number.isFinite(retrieved.getTime())
    ? `retrieved ${retrieved.toISOString()}` : "with unavailable retrieval time";
  return `${subject} refresh failed: ${error}. Retained data ${age}.`;
}

/** A figure and what it is, value first so the column of numbers is what the eye reads. */
function FigureLine({
  value,
  label,
  note,
  width,
  valueWidth,
}: {
  value: string;
  label: string;
  note?: string;
  width: number;
  valueWidth: number;
}) {
  const text = [label, note].filter(Boolean).join(", ");
  return (
    <Prose
      text={text}
      width={width}
      color={colors.textDim}
      prefix={`${value.padEnd(valueWidth)}  `}
      prefixColor={colors.textBright}
    />
  );
}

const PAY_PARTS: Array<{ key: keyof CloudExecutiveRowPayload; label: string }> =
  [
    { key: "salary", label: "Salary" },
    { key: "bonus", label: "Bonus" },
    { key: "stockAwards", label: "Stock" },
    { key: "optionAwards", label: "Options" },
    { key: "nonEquityIncentive", label: "Incentive" },
    { key: "pensionAndDeferred", label: "Pension" },
    { key: "allOther", label: "Other" },
  ];

/**
 * How the chief executive's pay was made up, as one bar. Salary is usually
 * a sliver and equity most of it; seeing that beats the table. The terminal
 * draws block runs with at least one cell per piece so a small one still
 * shows; the desktop draws real elements so a piece can be thinner than a cell.
 */
function PayMixBar({
  row,
  width,
}: {
  row: CloudExecutiveRowPayload;
  width: number;
}) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  // Colours follow the pieces that are drawn, so the common salary and stock
  // pair never lands on two neighbouring shades of the palette.
  const parts = PAY_PARTS.map((part) => ({
    ...part,
    value: (row[part.key] as number | null) ?? 0,
  })).filter((part) => part.value > 0).map((part, index) => ({ ...part, color: getChartIndicatorColor(index) }));
  const sum = parts.reduce((total, part) => total + part.value, 0);
  if (sum <= 0) return null;
  const barWidth = Math.max(10, Math.min(width, 60));
  let cells = parts.map((part) =>
    Math.max(1, Math.round((part.value / sum) * barWidth)),
  );
  // Rounding and the one-cell floor can overshoot; trim the largest piece.
  while (cells.reduce((a, b) => a + b, 0) > barWidth) {
    const largest = cells.indexOf(Math.max(...cells));
    cells[largest] = cells[largest]! - 1;
  }
  cells = cells.map((count) => Math.max(1, count));
  return (
    <Box flexDirection="column">
      {isDesktopWeb ? (
        <Box
          height={1}
          flexDirection="row"
          alignItems="center"
          width={barWidth}
          style={{ height: "9px", borderRadius: "2px", overflow: "hidden" }}
        >
          {parts.map((part) => (
            <Box
              key={part.key}
              backgroundColor={part.color}
              style={{ width: `${((part.value / sum) * 100).toFixed(2)}%`, height: "100%", minWidth: "2px" }}
            />
          ))}
        </Box>
      ) : (
        <Box height={1} flexDirection="row">
          {parts.map((part, index) => (
            <Text key={part.key} fg={part.color}>
              {"█".repeat(cells[index]!)}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap">
        {parts.map((part) => (
          <Box key={part.key} flexDirection="row" alignItems="center" marginRight={2}>
            {isDesktopWeb ? (
              <Box
                width={1}
                height={1}
                marginRight={1}
                backgroundColor={part.color}
                style={{ width: "8px", height: "8px", borderRadius: "2px" }}
              />
            ) : <Text fg={part.color}>■ </Text>}
            <Text fg={colors.textDim}>{part.label} </Text>
            <Text fg={colors.text}>
              {Math.round((part.value / sum) * 100)}%
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

type OfficerColumn = DataTableColumn & { id: "name" | "title" | "equity" | "total" };
const OFFICER_COLUMNS: OfficerColumn[] = [
  { id: "name", label: "NAME", width: 18, align: "left" },
  { id: "title", label: "TITLE", width: 16, align: "left", flexGrow: 1 },
  { id: "equity", label: "EQ%", width: 4, align: "right" },
  { id: "total", label: "TOTAL", width: 8, align: "right" },
];

function renderOfficerCell(row: CloudExecutiveRowPayload, column: OfficerColumn): DataTableCell {
  switch (column.id) {
    case "name": return { text: row.name, color: colors.textBright };
    case "title": return { text: row.title.replace(/\s+/g, " ").trim(), color: colors.textDim };
    case "equity": return { text: equityShare(row), color: colors.textDim };
    case "total": return { text: formatPay(row.total), color: colors.text, attributes: TextAttributes.BOLD };
  }
}

function ExecutiveRows({
  rows,
  width,
}: {
  rows: CloudExecutiveRowPayload[];
  width: number;
}) {
  if (width < 52) {
    return <Box flexDirection="column">
      {rows.map((row) => <Prose
        key={`${row.name}-${row.total}`}
        text={[row.name, row.title, equityShare(row) ? `${equityShare(row)} equity` : null].filter(Boolean).join(" · ")}
        width={width}
        prefix={`${formatPay(row.total).padEnd(9)} `}
        prefixColor={colors.textBright}
        color={colors.textDim}
      />)}
    </Box>;
  }
  // The name column fits the longest name so the title starts after a kit gutter.
  const nameWidth = Math.min(24, Math.max(10, ...rows.map((row) => row.name.length)));
  const columns = OFFICER_COLUMNS.map((column) => column.id === "name" ? { ...column, width: nameWidth } : column);
  const height = rows.length + 1;
  return (
    <Box flexDirection="column" height={height} flexShrink={0}>
      <DataTableView<CloudExecutiveRowPayload, OfficerColumn>
        columns={columns}
        items={rows}
        selection={{ kind: "none" }}
        rootWidth={width}
        rootHeight={height}
        // The scroll body owns the gutter, so the table does not add its own.
        horizontalPadding={0}
        virtualize={false}
        sortColumnId={null}
        sortDirection="asc"
        getItemKey={(row, index) => `${row.name}-${row.total}-${index}`}
        renderCell={renderOfficerCell}
        emptyStateTitle="No named executive officers."
      />
    </Box>
  );
}

/**
 * What a key figure is about, so a filer's "Say on Pay Approval, 2025 Annual
 * Meeting" is recognised as the "prior say-on-pay support" computed here.
 */
function figureTopic(label: string): string {
  const letters = label.toLowerCase().replace(/[^a-z]/g, "");
  if (letters.includes("sayonpay")) return "sayonpay";
  if (letters.includes("payratio") || letters.includes("ceotomedian")
    || (letters.includes("median") && letters.includes("ratio"))) return "payratio";
  // The median's pay is its own figure; the pay ratio line carries it only as a note.
  if (letters.includes("medianemployee")) return "medianpay";
  return letters;
}

function figuresOf(statement: CloudProxyStatementPayload) {
  const figures: Array<{ value: string; label: string; note?: string }> = [];
  const ceo = statement.ceo;
  if (ceo?.total != null && Number.isFinite(ceo.total)) {
    const change = formatChange(ceo.total, ceo.priorYearTotal);
    figures.push({
      value: formatPay(ceo.total),
      label: `${ceo.name} total pay`,
      note: change
        ? `${change} vs prior year`
        : (statement.fiscalYearLabel ?? undefined),
    });
  }
  if (statement.payRatio !== null) {
    figures.push({
      value: formatRatio(statement.payRatio),
      label: "CEO to median employee",
      note: statement.medianEmployeePay
        ? `median ${formatPay(statement.medianEmployeePay)}`
        : undefined,
    });
  }
  if (ceo) {
    const share = equityShare(ceo);
    if (share) figures.push({ value: share, label: "CEO pay in equity" });
  }
  if (statement.sayOnPayPriorSupport !== null) {
    figures.push({
      value: `${Math.round(statement.sayOnPayPriorSupport)}%`,
      label: "prior say-on-pay support",
    });
  }
  const seen = new Set(figures.map((figure) => figureTopic(figure.label)));
  if (statement.payRatio !== null && statement.medianEmployeePay) seen.add("medianpay");
  for (const figure of statement.keyFigures ?? []) {
    if (figures.length >= 8) break;
    const topic = figureTopic(figure.label);
    if (seen.has(topic)) continue;
    seen.add(topic);
    figures.push({
      value: figure.value,
      label: figure.label,
      note: figure.note || undefined,
    });
  }
  return figures;
}

export function ExecutivesPane({
  focused,
  width,
  nested = false,
}: {
  focused: boolean;
  width: number;
  height: number;
  /** Inside Ticker Research, whose own tab strip keeps h/l and the arrows. */
  nested?: boolean;
}) {
  const { symbol } = useBoundTicker();
  const ticker = symbol ? symbol.toUpperCase() : null;
  if (!ticker) return <EmptyState title="Pick a ticker to see its executives." />;
  return <ExecutiveResearch key={ticker} ticker={ticker} focused={focused} width={width} nested={nested} />;
}

export function ExecutivesResearchTab(props: { focused: boolean; width: number; height: number }) {
  return <ExecutivesPane {...props} nested />;
}

function ExecutiveResearch({ ticker, focused, width, nested }: { ticker: string; focused: boolean; width: number; nested: boolean }) {
  const nativePaneChrome = useUiCapabilities().nativePaneChrome === true;
  const rendererHost = useRendererHost();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [selectedYear, setYear] = usePaneStateValue<number | null>("proxyYear", null);
  const loadYears = useCallback((force: boolean) => loadProxyStatements(ticker, { force }), [ticker]);
  const list = useAsyncResource(loadYears, { clearOnError: discardProxyData });
  const years = useMemo(() => list.data?.data?.proxies ?? [], [list.data]);
  const year = years.some(entry => entry.proxyYear === selectedYear)
    ? selectedYear : years[0]?.proxyYear ?? null;
  const loadStatement = useCallback((force: boolean) => loadProxyStatement(ticker, year!, { force }), [ticker, year]);
  const detail = useAsyncResource(year === null ? null : loadStatement, { clearOnError: discardProxyData });
  const statement = detail.data?.data ?? null;
  const loading = list.loading || detail.loading;
  const listError = list.error ?? list.data?.refreshError;
  const statementError = detail.error ?? detail.data?.refreshError;
  usePaneNoticeFooter({
    registrationId: `${EXECUTIVES_PANE_ID}:data-notices`,
    notices: [
      list.data?.data && listError
        ? retainedDataNotice("Proxy list", listError, list.data.fetchedAt) : null,
      detail.data?.data && statementError
        ? retainedDataNotice(`${year} proxy`, statementError, detail.data.fetchedAt) : null,
    ].filter((notice): notice is string => notice !== null),
    focused,
  });
  const refresh = useCallback(() => {
    void list.reload();
    if (year !== null) void detail.reload();
  }, [list.reload, detail.reload, year]);

  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (scrollBox) scrollBox.scrollTop = 0;
  }, [year]);

  const openFiling = useCallback(() => {
    if (statement?.docUrl) void rendererHost.openExternal(statement.docUrl);
  }, [rendererHost, statement]);

  const nextYear = useCallback(() => {
    if (years.length < 2) return;
    const index = years.findIndex((entry) => entry.proxyYear === year);
    setYear(years[(index + 1) % years.length]!.proxyYear);
  }, [setYear, year, years]);

  const scrollBy = useCallback((delta: number) => {
    const scrollBox = scrollRef.current;
    if (!scrollBox?.viewport) return;
    const max = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
    scrollBox.scrollTop = Math.max(
      0,
      Math.min(max, scrollBox.scrollTop + delta),
    );
  }, []);

  useShortcut(
    (event) => {
      if (isPlainKey(event, "o")) {
        event.preventDefault();
        openFiling();
      } else if (isPlainKey(event, "r")) {
        refresh();
      } else if (isPlainKey(event, "j", "down")) {
        // One line per press; marked handled so the pane scroll keys, which
        // page this statement, do not scroll it again.
        event.preventDefault();
        scrollBy(1);
      } else if (isPlainKey(event, "k", "up")) {
        event.preventDefault();
        scrollBy(-1);
      }
    },
    { enabled: focused, scope: "executives" },
  );

  usePaneFooter(EXECUTIVES_PANE_ID, () => {
    const info: PaneFooterSegment[] = [];
    if (loading)
      info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    if (statement) {
      info.push({
        id: "filed",
        parts: [
          { text: `filed ${formatFiled(statement.filedAt)}`, tone: "muted" },
        ],
      });
    }
    // `r` refreshes every pane, so it gets no hint here.
    const hints: PaneHint[] = statement ? [{ id: "open", key: "o", label: "pen filing", onPress: openFiling }] : [];
    // The year strip answers h/l only where it is the pane's own strip; `y`
    // steps it everywhere, including under Ticker Research's strip.
    if (years.length > 1) hints.push({ id: "year", key: "y", label: "ear", onPress: nextYear });
    return { info, hints };
  }, [loading, statement, openFiling, years.length, nextYear]);

  const figures = useMemo(
    () => (statement ? figuresOf(statement) : []),
    [statement],
  );
  const yearTabs = useMemo(() => years.map((entry) => ({
    label: `${entry.proxyYear} proxy`,
    value: String(entry.proxyYear),
  })), [years]);
  const selectYear = useCallback((value: string) => setYear(Number(value)), [setYear]);
  const tabsInHeader = usePaneHeaderTabs(years.length > 1 ? {
    tabs: yearTabs,
    activeValue: year === null ? "" : String(year),
    onSelect: selectYear,
    focused,
  } : null);
  // Nested in Ticker Research the years stay in the body: the terminal keeps
  // its tab row, the desktop picks the year from the query bar.
  const yearStrip = years.length > 1 && !tabsInHeader;
  const yearFilters = useMemo<QueryBarFilter[]>(() => yearStrip && nativePaneChrome ? [{
    id: "year",
    label: "Proxy",
    inline: years.length <= 4,
    value: year === null ? "" : String(year),
    options: years.map((entry) => ({ label: String(entry.proxyYear), value: String(entry.proxyYear) })),
    onChange: selectYear,
  }] : [], [nativePaneChrome, selectYear, year, yearStrip, years]);
  // The year is named by the tabs or the filter when there is a choice; a
  // single proxy says which one it is here.
  const meta = statement ? [
    years.length > 1 ? null : `${statement.proxyYear} proxy`,
    statement.fiscalYearLabel ? `pay for ${statement.fiscalYearLabel.replace(/^Fiscal/, "fiscal")}` : null,
    statement.meetingDate ? `meeting ${formatFiled(statement.meetingDate)}` : null,
  ].filter(Boolean).join(" · ") : "";
  const bodyWidth = Math.max(12, width - 2);
  const proseWidth = Math.min(bodyWidth, MAX_PROSE_WIDTH);
  const valueWidth = Math.min(
    14,
    Math.max(4, ...figures.map((figure) => figure.value.length)),
  );

  if (list.loading && !list.data?.data) {
    return <PaneStatusBody loading align="center" loadingLabel="Loading proxy statement..." />;
  }
  if (!list.error && years.length === 0) {
    return <EmptyState title={`No proxy statement on file for ${ticker}.`} />;
  }
  if (list.error && !list.data?.data) {
    return <PaneStatusBody error={list.error} errorTitle="Could not load executive compensation." />;
  }

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minHeight={0}
      overflow="hidden"
    >
      {yearStrip && !nativePaneChrome && (
        <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
          <Tabs
            tabs={yearTabs}
            activeValue={year === null ? "" : String(year)}
            onSelect={selectYear}
            compact
            variant="bare"
            focused={focused}
            keyboardNavigation={!nested}
          />
        </Box>
      )}
      {(yearFilters.length > 0 || meta) && <QueryBar width={width} filters={yearFilters} meta={meta || undefined} />}
      <ScrollBox
        ref={scrollRef}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
        scrollY
        paddingX={1}
      >
        {statement ? (
          <Box
            flexDirection="column"
            width={nativePaneChrome ? "100%" : bodyWidth}
          >
            {figures.length > 0 && (
              <Box flexDirection="column">
                <SectionHeading title="KEY FIGURES" />
                {figures.map((figure) => (
                  <FigureLine
                    key={`${figure.label}-${figure.value}`}
                    value={figure.value}
                    label={figure.label}
                    note={figure.note}
                    width={proseWidth}
                    valueWidth={valueWidth}
                  />
                ))}
              </Box>
            )}
            {statement.ceo && (
              <Box flexDirection="column">
                <SectionHeading marginTop={figures.length > 0 ? 1 : 0}
                  title={`HOW ${statement.ceo.name.split(" ").pop()?.toUpperCase() ?? "THE CEO"} WAS PAID`}
                />
                <PayMixBar row={statement.ceo} width={proseWidth} />
              </Box>
            )}
            {statement.namedExecutives.length > 0 && (
              <Box flexDirection="column">
                <SectionHeading marginTop={1} title="NAMED EXECUTIVE OFFICERS" />
                <ExecutiveRows
                  rows={statement.namedExecutives}
                  width={proseWidth}
                />
              </Box>
            )}
            {statement.highlights && (
              <Box flexDirection="column">
                <SectionHeading marginTop={1} title="WHAT CHANGED" />
                {statement.highlights.split("\n").map((point) => (
                  <Prose
                    key={point}
                    text={point}
                    width={proseWidth}
                    color={colors.text}
                    prefix="• "
                  />
                ))}
              </Box>
            )}
          </Box>
        ) : (
          <PaneStatusBody loading={detail.loading} error={detail.error} errorTitle="Could not load this proxy statement."
            empty={detail.data?.data === null} emptyTitle={`No ${year} proxy statement on file for ${ticker}.`} />
        )}
      </ScrollBox>
    </Box>
  );
}
