import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CloudExecutiveRowPayload,
  CloudProxyStatementPayload,
  CloudProxyStatementSummaryPayload,
} from "../../../api-client";
import {
  EmptyState, PaneStatusBody, Prose, SectionHeading, Spinner,
  Tabs,
  usePaneFooter,
  type PaneFooterSegment
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { colors, getChartIndicatorColor } from "../../../theme/colors";
import {
  Box,
  ScrollBox,
  Text,
  TextAttributes,
  useRendererHost,
  useUiCapabilities,
  type ScrollBoxRenderable,
} from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { useBoundTicker } from "../shared/ticker-request";
import { loadProxyStatement, loadProxyStatements } from "./data";
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
 * How the chief executive's pay was made up, as one bar of blocks. Salary
 * is usually a sliver and equity most of it; seeing that beats the table.
 * Every piece gets at least one cell so a small one still shows.
 */
function PayMixBar({
  row,
  width,
}: {
  row: CloudExecutiveRowPayload;
  width: number;
}) {
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
      <Box height={1} flexDirection="row">
        {parts.map((part, index) => (
          <Text key={part.key} fg={part.color}>
            {"█".repeat(cells[index]!)}
          </Text>
        ))}
      </Box>
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
  if (ceo?.total) {
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
  const nativePaneChrome = useUiCapabilities().nativePaneChrome === true;
  const rendererHost = useRendererHost();

  const [years, setYears] = useState<CloudProxyStatementSummaryPayload[]>([]);
  const [year, setYear] = useState<number | null>(null);
  const [statement, setStatement] = useState<CloudProxyStatementPayload | null>(
    null,
  );
  const [status, setStatus] = useState<
    "idle" | "loading" | "loaded" | "none" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setStatus("loading");
    setStatement(null);
    loadProxyStatements(ticker)
      .then((payload) => {
        if (cancelled) return;
        setYears(payload.proxies);
        setYear(payload.proxies[0]?.proxyYear ?? null);
        setStatus(payload.proxies.length > 0 ? "loaded" : "none");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        // No proxy on file answers 404, which is not an error worth a message.
        const message =
          caught instanceof Error ? caught.message : String(caught);
        if (/404|not found|no proxy/i.test(message)) {
          setYears([]);
          setStatus("none");
          return;
        }
        setError(message);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  useEffect(() => {
    if (!ticker || year === null) return;
    let cancelled = false;
    loadProxyStatement(ticker, year)
      .then((payload) => {
        if (!cancelled) setStatement(payload);
      })
      .catch((caught: unknown) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, year]);

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
    if (status === "loading")
      info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    if (statement) {
      info.push({
        id: "filed",
        parts: [
          { text: `filed ${formatFiled(statement.filedAt)}`, tone: "muted" },
        ],
      });
    }
    const hints = statement
      ? [{ id: "open", key: "o", label: "pen filing", onPress: openFiling }]
      : [];
    return { info, hints };
  }, [status, statement, openFiling]);

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

  if (!ticker)
    return <EmptyState title="Pick a ticker to see its executives." />;
  if (status === "loading" && !statement) {
    return (
      <PaneStatusBody loading align="center" loadingLabel="Loading proxy statement..." />
    );
  }
  if (status === "none") {
    return (
      <EmptyState
        title={`No proxy statement on file for ${ticker}.`}
        message="Executive pay comes from the annual DEF 14A. Funds, SPACs and foreign filers do not file one with a compensation table."
      />
    );
  }
  if (status === "error") {
    return (
      <PaneStatusBody error={error ?? "Could not load executive compensation."} errorTitle="Could not load executive compensation." />
    );
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
            <Box height={1} marginTop={1}>
              <Text fg={colors.textDim}>
                Read from the DEF 14A and checked against the filing. Equity
                valued at grant. Press o to open the filing.
              </Text>
            </Box>
          </Box>
        ) : (
          <Spinner label="Loading..." />
        )}
      </ScrollBox>
    </Box>
  );
}
