import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CloudRiskNotePayload,
} from "../../../api-client";
import {
  EmptyState, PaneStatusBody, Prose, SectionHeading, Spinner,
  Tabs,
  usePaneFooter,
  type PaneFooterSegment
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { useAsyncResource } from "../../../react/async-resource";
import { colors } from "../../../theme/colors";
import {
  Box,
  ScrollBox,
  Text,
  useRendererHost,
  useUiCapabilities,
  type ScrollBoxRenderable,
} from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { usePluginPaneState } from "../../runtime";
import { useBoundTicker } from "../shared/ticker-request";
import { discardRiskData, loadRiskReport, loadRiskReports } from "./data";

export const RISK_FACTORS_PANE_ID = "risk-factors";

const MAX_PROSE_WIDTH = 100;

function noteFor(
  notes: CloudRiskNotePayload[],
  index: number,
): string | undefined {
  return notes.find((note) => note.index === index)?.text;
}

/** A risk heading, its group, and the model's line under it. */
function RiskLine({
  tag,
  group,
  heading,
  note,
  width,
}: {
  tag: string;
  group: string | null;
  heading: string;
  note?: string;
  width: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box height={1} flexDirection="row" gap={1} overflow="hidden">
        <Text fg={colors.textBright}>{tag}</Text>
        {group ? <Text fg={colors.textDim}>{group}</Text> : null}
      </Box>
      <Prose
        text={heading}
        width={width}
        color={colors.text}
      />
      {note ? (
        <Prose
          text={note}
          width={width}
          color={colors.textDim}
          prefix="  "
        />
      ) : null}
    </Box>
  );
}

export function RiskFactorsPane({
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

  // The year is remembered with the pane; the ticker it was chosen on is the
  // one the pane opened with, so a restored year applies to it.
  const [selectedYear, setSelectedYear] = usePluginPaneState<number | null>("filingYear", null);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(ticker);
  const listLoader = useCallback((force: boolean) => loadRiskReports(ticker!, { force }), [ticker]);
  const list = useAsyncResource(ticker ? listLoader : null, { clearOnError: discardRiskData });
  const years = useMemo(() => [...(list.data?.reports ?? [])].sort((a, b) => b.reportYear - a.reportYear), [list.data]);
  // Null follows the newest discovered filing; an explicit choice stays on that year.
  const year = selectedTicker === ticker && selectedYear !== null
    ? selectedYear : years[0]?.reportYear ?? null;
  const reportLoader = useCallback((force: boolean) => loadRiskReport(ticker!, year!, { force }), [ticker, year]);
  const detail = useAsyncResource(ticker && year !== null ? reportLoader : null, { clearOnError: discardRiskData });
  const report = detail.data;
  const listError = list.error ?? list.data?.refreshError ?? null;
  const reportError = detail.error ?? report?.refreshError ?? null;
  const refresh = useCallback(() => {
    void list.reload();
    if (year !== null) void detail.reload();
  }, [list.reload, detail.reload, year]);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (scrollBox) scrollBox.scrollTop = 0;
  }, [ticker, year]);

  const openFiling = useCallback(() => {
    if (report?.docUrl) void rendererHost.openExternal(report.docUrl);
  }, [rendererHost, report]);

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
      if (isPlainKey(event, "r")) refresh();
      else if (isPlainKey(event, "o")) openFiling();
      else if (isPlainKey(event, "j", "down")) scrollBy(1);
      else if (isPlainKey(event, "k", "up")) scrollBy(-1);
    },
    { enabled: focused, scope: "risk-factors" },
  );

  usePaneFooter(RISK_FACTORS_PANE_ID, () => {
    const info: PaneFooterSegment[] = [];
    if (list.loading || detail.loading)
      info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    if (listError) info.push({ id: "list-error", parts: [{ text: `Report list: ${listError}`, tone: "warning" }] });
    if (reportError) info.push({ id: "report-error", parts: [{ text: `${year} report: ${reportError}`, tone: "warning" }] });
    if ((listError || list.data?.stale) && list.data) {
      info.push({ id: "list-stale", parts: [{ text: `List cached ${new Date(list.data.fetchedAt).toISOString()}`, tone: "muted" }] });
    }
    if ((reportError || report?.stale) && report) {
      info.push({ id: "report-stale", parts: [{ text: `Report cached ${new Date(report.fetchedAt).toISOString()}`, tone: "muted" }] });
    }
    const hints = report?.docUrl
      ? [{ id: "open", key: "o", label: "pen filing", onPress: openFiling }]
      : [];
    return { info, hints };
  }, [list.loading, detail.loading, listError, reportError, list.data, report, year, openFiling]);

  const bodyWidth = Math.max(12, width - 2);
  const proseWidth = Math.min(bodyWidth, MAX_PROSE_WIDTH);

  if (!ticker) return <EmptyState title="Pick a ticker to see its risk factors." />;
  if (!list.data && list.loading) return <PaneStatusBody loading align="center" loadingLabel="Loading risk factors..." />;
  if (!list.data && listError && year === null) return <PaneStatusBody error={listError} errorTitle="Could not load risk reports." />;
  if (year === null) return <EmptyState title={`No 10-K risk factors on file for ${ticker}.`} />;

  const diff = report?.diff ?? null;
  const summaryLine = report
    ? [
        `${report.reportYear} 10-K`,
        `Filed ${report.filedAt?.slice(0, 10) || "unavailable"}`,
        `Report updated ${report.updatedAt?.slice(0, 10) || "unavailable"}`,
        `${report.riskCount} risks in ${report.groupCount} groups`,
        diff
          ? `${diff.added.length} new, ${diff.removed.length} dropped, ${diff.reworded.length} reworded vs prior year`
          : "no prior year on file",
      ].join("  ·  ")
    : "";

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
              label: `${entry.reportYear} 10-K`,
              value: String(entry.reportYear),
            }))}
            activeValue={year === null ? "" : String(year)}
            onSelect={(value) => { setSelectedTicker(ticker); setSelectedYear(Number(value)); }}
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
        {report ? (
          <Box
            flexDirection="column"
            width={nativePaneChrome ? "100%" : bodyWidth}
          >
            <Prose
              text={summaryLine}
              width={proseWidth}
              color={colors.textDim}
            />
            {report.overview ? (
              <Box flexDirection="column">
                <SectionHeading marginTop={1}
                  title={diff ? "WHAT THE CHANGES SAY" : "WHAT DOMINATES"}
                />
                {report.overview.split("\n").map((point) => (
                  <Prose
                    key={point}
                    text={point}
                    width={proseWidth}
                    color={colors.text}
                    prefix="• "
                  />
                ))}
              </Box>
            ) : null}
            {diff ? (
              <Box flexDirection="column">
                <SectionHeading marginTop={1} title="WHAT CHANGED" />
                {diff.added.length === 0 &&
                diff.removed.length === 0 &&
                diff.reworded.length === 0 ? (
                  <Prose
                    text="Every risk carried over with its text substantially unchanged."
                    width={proseWidth}
                    color={colors.textDim}
                  />
                ) : null}
                {diff.added.map((index) => (
                  <RiskLine
                    key={`new-${index}`}
                    tag="NEW"
                    group={report.risks[index]?.group ?? null}
                    heading={report.risks[index]?.heading ?? ""}
                    note={noteFor(report.notes.added, index)}
                    width={proseWidth}
                  />
                ))}
                {diff.removed.map((risk, index) => (
                  <RiskLine
                    key={`dropped-${risk.heading}`}
                    tag="DROPPED"
                    group={risk.group}
                    heading={risk.heading}
                    note={noteFor(report.notes.removed, index)}
                    width={proseWidth}
                  />
                ))}
                {diff.reworded.map((item) => (
                  <RiskLine
                    key={`reworded-${item.index}`}
                    tag={`${Math.round((1 - item.similarity) * 100)}% REWRITTEN`}
                    group={report.risks[item.index]?.group ?? null}
                    heading={report.risks[item.index]?.heading ?? ""}
                    note={noteFor(report.notes.reworded, item.index)}
                    width={proseWidth}
                  />
                ))}
              </Box>
            ) : report.notes.top.length > 0 ? (
              <Box flexDirection="column">
                <SectionHeading marginTop={1} title="MOST SPECIFIC TO THE COMPANY" />
                {report.notes.top.map((note) => (
                  <RiskLine
                    key={`top-${note.index}`}
                    tag={String(note.index + 1).padStart(2, "0")}
                    group={report.risks[note.index]?.group ?? null}
                    heading={report.risks[note.index]?.heading ?? ""}
                    note={note.text}
                    width={proseWidth}
                  />
                ))}
              </Box>
            ) : null}
            <Box flexDirection="column">
              <SectionHeading marginTop={1} title={`ALL ${report.riskCount} RISK FACTORS`} />
              {report.risks.map((risk, index) => (
                <Prose
                  key={`${index}-${risk.heading}`}
                  text={risk.heading}
                  width={proseWidth}
                  color={colors.text}
                  prefix={`${String(index + 1).padStart(2, "0")} `}
                />
              ))}
            </Box>

          </Box>
        ) : reportError ? (
          <PaneStatusBody error={reportError} errorTitle={`Could not load ${year} risk report.`} />
        ) : (
          <Spinner label="Loading..." />
        )}
      </ScrollBox>
    </Box>
  );
}
