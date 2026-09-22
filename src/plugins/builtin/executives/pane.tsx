import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CloudExecutiveRowPayload,
  CloudProxyStatementPayload,
} from "../../../api-client";
import {
  EmptyState, PaneStatusBody, Prose, SectionHeading,
  Tabs,
  usePaneFooter,
  usePaneNoticeFooter,
  type PaneFooterSegment
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
  shortTitle,
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
  const parts = PAY_PARTS.map((part, index) => ({
    ...part,
    value: (row[part.key] as number | null) ?? 0,
    color: getChartIndicatorColor(index),
  })).filter((part) => part.value > 0);
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
          <Box key={part.key} flexDirection="row" marginRight={2}>
            <Text fg={part.color}>■ </Text>
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
  // Name, title, equity share, total. The title takes whatever is left.
  const totalWidth = 9;
  const equityWidth = 5;
  const nameWidth = Math.min(
    24,
    Math.max(10, ...rows.map((row) => row.name.length)),
  );
  const titleWidth = Math.max(
    8,
    width - nameWidth - equityWidth - totalWidth - 6,
  );
  return (
    <Box flexDirection="column">
      <Box height={1} flexDirection="row">
        <Text fg={colors.textDim}>
          {"NAME".padEnd(nameWidth)} {"TITLE".padEnd(titleWidth)}{" "}
          {"EQ%".padStart(equityWidth)} {"TOTAL".padStart(totalWidth)}
        </Text>
      </Box>
      {rows.map((row) => (
        <Box key={`${row.name}-${row.total}`} height={1} flexDirection="row">
          <Text fg={colors.textBright}>
            {shortTitle(row.name, nameWidth).padEnd(nameWidth)}
          </Text>
          <Text fg={colors.textDim}>
            {" "}
            {shortTitle(row.title, titleWidth).padEnd(titleWidth)}{" "}
          </Text>
          <Text fg={colors.textDim}>
            {equityShare(row).padStart(equityWidth)}{" "}
          </Text>
          <Text fg={colors.text} attributes={TextAttributes.BOLD}>
            {formatPay(row.total).padStart(totalWidth)}
          </Text>
        </Box>
      ))}
    </Box>
  );
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
  const seen = new Set(figures.map((figure) => figure.label.toLowerCase()));
  for (const figure of statement.keyFigures ?? []) {
    if (figures.length >= 8) break;
    if (seen.has(figure.label.toLowerCase())) continue;
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
}: {
  focused: boolean;
  width: number;
  height: number;
}) {
  const { symbol } = useBoundTicker();
  const ticker = symbol ? symbol.toUpperCase() : null;
  if (!ticker) return <EmptyState title="Pick a ticker to see its executives." />;
  return <ExecutiveResearch key={ticker} ticker={ticker} focused={focused} width={width} />;
}

function ExecutiveResearch({ ticker, focused, width }: { ticker: string; focused: boolean; width: number }) {
  const nativePaneChrome = useUiCapabilities().nativePaneChrome === true;
  const rendererHost = useRendererHost();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [selectedYear, setYear] = usePaneStateValue<number | null>("proxyYear", null);
  const loadYears = useCallback((force: boolean) => loadProxyStatements(ticker, { force }), [ticker]);
  const list = useAsyncResource(loadYears, { clearOnError: discardProxyData });
  const years = list.data?.data?.proxies ?? [];
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
        openFiling();
      } else if (isPlainKey(event, "r")) {
        refresh();
      } else if (isPlainKey(event, "j", "down")) {
        scrollBy(1);
      } else if (isPlainKey(event, "k", "up")) {
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
    const hints = statement ? [{ id: "open", key: "o", label: "pen filing", onPress: openFiling }] : [];
    return { info, hints };
  }, [loading, statement, openFiling]);

  const figures = useMemo(
    () => (statement ? figuresOf(statement) : []),
    [statement],
  );
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
      {years.length > 1 && (
        <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
          <Tabs
            tabs={years.map((entry) => ({
              label: `${entry.proxyYear} proxy`,
              value: String(entry.proxyYear),
            }))}
            activeValue={year === null ? "" : String(year)}
            onSelect={(value) => setYear(Number(value))}
            compact
            variant="bare"
            focused={focused}
          />
        </Box>
      )}
      <ScrollBox
        ref={scrollRef}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
        paddingX={1}
      >
        {statement ? (
          <Box
            flexDirection="column"
            width={nativePaneChrome ? "100%" : bodyWidth}
          >
            <Prose
              text={[
                `${statement.proxyYear} proxy statement`,
                statement.fiscalYearLabel
                  ? `pay for ${statement.fiscalYearLabel.replace(/^Fiscal/, "fiscal")}`
                  : null,
                statement.meetingDate
                  ? `meeting ${formatFiled(statement.meetingDate)}`
                  : null,
              ]
                .filter(Boolean)
                .join("  ·  ")}
              width={proseWidth}
              color={colors.textDim}
            />
            {figures.length > 0 && (
              <Box flexDirection="column">
                <SectionHeading marginTop={1} title="KEY FIGURES" />
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
                <SectionHeading marginTop={1}
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
