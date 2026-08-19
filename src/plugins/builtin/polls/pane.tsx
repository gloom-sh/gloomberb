import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, ScrollBox, Text, TextAttributes, type InputRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import {
  DataTableStackView,
  EmptyState,
  InputSearchBar,
  PaneStatusBody,
  Tabs,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
} from "../../../components";
import {
  CompositeChart,
  pricePointsToResolvedSeries,
} from "../../../components/chart/composite";
import { colors, priceColor } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { openUrl } from "../../../components/ui/external-link";
import type { PricePoint } from "../../../types/financials";
import type { PaneProps } from "../../../types/plugin";
import { nextStackSortPreference } from "./hooks";
import { useAutoRefresh, useUpdatedAgo } from "../shared/auto-refresh";
import { fetchVoteHubPolls } from "./client";
import {
  computeMovingAverage,
  computePollAverages,
  computePollsterAverages,
  computePollTrend,
  DEFAULT_POLL_SORT,
  filterPollRows,
  formatPollDate,
  normalizeVoteHubPoll,
  sortPollRows,
  type PollSortColumnId,
  type PollSortPreference,
} from "./normalize";
import type { PollDetailTab, PollRow, PollTabId } from "./types";

type LoadStatus = "loading" | "loaded" | "error";

interface PollColumn extends DataTableColumn {
  id: "date" | "subject" | "pollster" | "pop" | "result";
}

const TABS: Array<{ value: PollTabId; label: string }> = [
  { value: "approval", label: "Approval" },
  { value: "favorability", label: "Favorability" },
  { value: "generic-ballot", label: "Generic" },
  { value: "us-senator", label: "Senate" },
  { value: "governor", label: "Governor" },
  { value: "us-representative", label: "House" },
];

const DETAIL_TABS: Array<{ value: PollDetailTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "trend", label: "Trend" },
  { value: "pollsters", label: "Pollsters" },
];

const TREND_WINDOW = 5;
const RECENT_POLL_COUNT = 10;

/**
 * Maps a poll answer label to a semantic color: approve/yes → positive,
 * disapprove/no → negative, everything else stays neutral. A leading
 * "approve" poll at 40% is still semantically positive, so this is label-based
 * (not probability-based like prediction markets).
 */
function answerChoiceColor(choice: string): string | undefined {
  const normalized = choice.trim().toLowerCase();
  if (/\b(approve|yes|favor|support|positive)\b/.test(normalized)) return colors.positive;
  if (/\b(disapprove|no|oppose|against|negative|unfavor)\b/.test(normalized)) return colors.negative;
  return undefined;
}

function createColumns(width: number): PollColumn[] {
  const dateWidth = 8;
  const popWidth = 7;
  // Both answers and both percentages of a two-way result must fit; a clipped
  // number is worse than a narrower subject column.
  const resultWidth = 32;
  const pollsterWidth = 14;
  const subjectWidth = Math.max(12, width - dateWidth - popWidth - resultWidth - pollsterWidth - 8);
  return [
    { id: "date", label: "DATE", width: dateWidth, align: "left" },
    { id: "subject", label: "SUBJECT", width: subjectWidth, align: "left" },
    { id: "pollster", label: "POLLSTER", width: pollsterWidth, align: "left" },
    { id: "pop", label: "SAMPLE", width: popWidth, align: "left" },
    { id: "result", label: "RESULT", width: resultWidth, align: "left" },
  ];
}

function renderPollCell(row: PollRow, column: PollColumn, selected: boolean): DataTableCell {
  const sel = selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "date":
      return { text: formatPollDate(row.endDate), color: sel ?? colors.textDim };
    case "subject":
      return { text: row.subject, color: sel ?? colors.textBright, attributes: TextAttributes.BOLD };
    case "pollster":
      return { text: row.pollster, color: sel ?? colors.textMuted };
    case "pop":
      return { text: row.population, color: sel ?? colors.textDim };
    case "result":
      return {
        text: row.result,
        color: sel ?? (row.lead != null ? priceColor(row.lead) : colors.text),
      };
  }
}

function AnswerBar({ pct, color, maxPct, width }: { pct: number; color: string; maxPct: number; width: number }) {
  const barWidth = maxPct > 0 ? Math.max(1, Math.round((pct / maxPct) * width)) : 0;
  return (
    <Box flexDirection="row" height={1} gap={1}>
      <Box width={barWidth} backgroundColor={color} />
      <Box flexGrow={1} />
    </Box>
  );
}

function PollOverview({ poll, allRows, width }: { poll: PollRow; allRows: PollRow[]; width: number }) {
  const lineWidth = Math.max(12, width - 2);
  const maxPct = Math.max(...poll.answers.map((a) => a.pct), 1);
  const labelWidth = Math.min(16, Math.floor(lineWidth * 0.35));
  const barWidth = Math.max(10, lineWidth - labelWidth - 12);

  const averages = useMemo(
    () => computePollAverages(allRows, poll.subject, RECENT_POLL_COUNT),
    [allRows, poll.subject],
  );
  const maxAvg = Math.max(...averages.map((a) => a.avgPct), 1);

  return (
    <ScrollBox flexGrow={1} scrollY>
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text fg={colors.textDim}>
          {poll.pollTypeLabel}
          {poll.sponsors.length > 0 ? ` · ${poll.sponsors.join(", ")}` : ""}
        </Text>
        <Text fg={colors.textDim}>
          {formatPollDate(poll.startDate)}–{formatPollDate(poll.endDate)}
          {` · ${poll.pollster} · ${poll.population}`}
          {poll.sampleSize != null ? ` · n=${poll.sampleSize.toLocaleString("en-US")}` : ""}
          {poll.marginOfError != null ? ` · ±${poll.marginOfError}%` : ""}
        </Text>
        {poll.partisan ? <Text fg={colors.textMuted}>Partisan: {poll.partisan}</Text> : null}
        {poll.internal ? <Text fg={colors.textMuted}>Internal poll</Text> : null}

        <Box height={1} />
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>This poll</Text>
        {poll.answers.map((answer) => {
          const choiceColor = answerChoiceColor(answer.choice);
          return (
          <Box key={answer.choice} flexDirection="row" height={1} gap={2}>
            <Box width={labelWidth}>
              <Text fg={choiceColor ?? colors.text} wrapMode="ellipsis">{answer.choice}</Text>
            </Box>
            <Box width={4} justifyContent="flex-end" flexDirection="row">
              <Text fg={choiceColor ?? (poll.leadChoice === answer.choice ? colors.textBright : colors.textDim)} attributes={TextAttributes.BOLD}>
                {Number.isInteger(answer.pct) ? `${answer.pct}` : answer.pct.toFixed(1)}
              </Text>
            </Box>
            <Box width={barWidth}>
              <AnswerBar
                pct={answer.pct}
                color={choiceColor ?? (poll.leadChoice === answer.choice ? colors.positive : colors.border)}
                maxPct={maxPct}
                width={barWidth}
              />
            </Box>
          </Box>
          );
        })}

        {averages.length > 0 && (
          <>
            <Box height={1} />
            <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
              {RECENT_POLL_COUNT}-poll weighted avg
            </Text>
            {averages.map((avg) => {
              const avgColor = answerChoiceColor(avg.choice);
              return (
              <Box key={avg.choice} flexDirection="row" height={1} gap={2}>
                <Box width={labelWidth}>
                  <Text fg={avgColor ?? colors.text} wrapMode="ellipsis">{avg.choice}</Text>
                </Box>
                <Box width={4} justifyContent="flex-end" flexDirection="row">
                  <Text fg={avgColor ?? colors.textBright} attributes={TextAttributes.BOLD}>
                    {avg.avgPct.toFixed(1)}
                  </Text>
                </Box>
                <Box width={barWidth}>
                  <AnswerBar
                    pct={avg.avgPct}
                    color={avgColor ?? colors.textBright}
                    maxPct={maxAvg}
                    width={barWidth}
                  />
                </Box>
                <Text fg={colors.textDim}>{avg.pollCount}</Text>
              </Box>
              );
            })}
          </>
        )}
      </Box>
    </ScrollBox>
  );
}

function PollTrend({
  poll,
  allRows,
  width,
  height,
}: {
  poll: PollRow;
  allRows: PollRow[];
  width: number;
  height: number;
}) {
  const leadingChoice = poll.leadChoice ?? poll.answers[0]?.choice ?? null;

  const trendData = useMemo(() => {
    if (!leadingChoice) return { points: [], ma: [] };
    const points = computePollTrend(allRows, poll.subject, leadingChoice);
    const ma = computeMovingAverage(points, TREND_WINDOW);
    return { points, ma };
  }, [allRows, poll.subject, leadingChoice]);

  if (!leadingChoice || trendData.points.length === 0) {
    return (
      <Box flexGrow={1} justifyContent="center" alignItems="center">
        <EmptyState title="No trend data." hint="Not enough polls for this subject." />
      </Box>
    );
  }

  if (trendData.points.length < 2) {
    return (
      <Box flexGrow={1} justifyContent="center" alignItems="center">
        <EmptyState title="Not enough data for a trend." hint="Need at least 2 polls." />
      </Box>
    );
  }

  const rawPoints: PricePoint[] = trendData.points.map((p) => ({
    date: new Date(`${p.date}T00:00:00Z`),
    close: p.value,
  }));

  const maPoints: PricePoint[] = trendData.ma.map((p) => ({
    date: new Date(`${p.date}T00:00:00Z`),
    close: p.value,
  }));

  const chartHeight = Math.max(height - 2, 4);

  const rawSeries = pricePointsToResolvedSeries(rawPoints, {
    id: "raw",
    label: leadingChoice,
    color: colors.textDim,
    unit: "%",
    unitGroup: "percent",
    style: "points",
    axis: "left",
    panelId: "pct",
  });

  const maSeries = maPoints.length > 0
    ? pricePointsToResolvedSeries(maPoints, {
        id: "ma",
        label: `${TREND_WINDOW}-poll avg`,
        color: colors.positive,
        unit: "%",
        unitGroup: "percent",
        style: "line",
        axis: "left",
        panelId: "pct",
      })
    : null;

  const series = maSeries ? [rawSeries, maSeries] : [rawSeries];

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="row" height={1} paddingX={1} gap={2}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{leadingChoice}</Text>
        <Text fg={colors.textDim}>
          {trendData.points.length} polls · {formatPollDate(trendData.points[0]!.date)}–{formatPollDate(trendData.points[trendData.points.length - 1]!.date)}
        </Text>
      </Box>
      <CompositeChart
        width={width}
        height={chartHeight}
        focused={false}
        interactive={false}
        series={series}
        panels={[{ id: "pct", scale: "linear" }]}
        axisWidth={8}
        showLegend={true}
        showTimeAxis={true}
        formatValue={(value: number) => `${value.toFixed(1)}%`}
      />
    </Box>
  );
}

function PollPollsters({
  poll,
  allRows,
  width,
}: {
  poll: PollRow;
  allRows: PollRow[];
  width: number;
}) {
  const leadingChoice = poll.leadChoice ?? poll.answers[0]?.choice ?? null;
  const pollsters = useMemo(
    () => computePollsterAverages(allRows, poll.subject, leadingChoice),
    [allRows, poll.subject, leadingChoice],
  );

  if (pollsters.length === 0) {
    return (
      <Box flexGrow={1} justifyContent="center" alignItems="center">
        <EmptyState title="No pollster data." hint="Not enough polls for this subject." />
      </Box>
    );
  }

  const lineWidth = Math.max(12, width - 2);
  const pollsterWidth = Math.min(22, Math.floor(lineWidth * 0.4));
  const numWidth = 4;
  const sampleWidth = 8;
  const barWidth = Math.max(8, lineWidth - pollsterWidth - numWidth - sampleWidth - 8);
  const maxAvg = Math.max(...pollsters.map((p) => p.avgPct), 1);

  return (
    <ScrollBox flexGrow={1} scrollY>
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="row" height={1} gap={2}>
          <Box width={pollsterWidth}>
            <Text fg={colors.textDim}>POLLSTER</Text>
          </Box>
          <Box width={numWidth} justifyContent="flex-end" flexDirection="row">
            <Text fg={colors.textDim}>AVG</Text>
          </Box>
          <Box width={sampleWidth} justifyContent="flex-end" flexDirection="row">
            <Text fg={colors.textDim}>N</Text>
          </Box>
          <Box width={3} justifyContent="flex-end" flexDirection="row">
            <Text fg={colors.textDim}>#</Text>
          </Box>
        </Box>
        {pollsters.map((entry) => (
          <Box key={entry.pollster} flexDirection="row" height={1} gap={2}>
            <Box width={pollsterWidth}>
              <Text fg={colors.text} wrapMode="ellipsis">{entry.pollster}</Text>
            </Box>
            <Box width={numWidth} justifyContent="flex-end" flexDirection="row">
              <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
                {entry.avgPct.toFixed(1)}
              </Text>
            </Box>
            <Box width={sampleWidth} justifyContent="flex-end" flexDirection="row">
              <Text fg={colors.textDim}>
                {entry.totalSample > 0 ? entry.totalSample.toLocaleString("en-US") : "—"}
              </Text>
            </Box>
            <Box width={3} justifyContent="flex-end" flexDirection="row">
              <Text fg={colors.textDim}>{entry.count}</Text>
            </Box>
            <Box width={barWidth}>
              <AnswerBar
                pct={entry.avgPct}
                color={colors.positive}
                maxPct={maxAvg}
                width={barWidth}
              />
            </Box>
          </Box>
        ))}
      </Box>
    </ScrollBox>
  );
}

function PollDetail({
  poll,
  allRows,
  width,
  height,
  detailTab,
  onDetailTabChange,
}: {
  poll: PollRow;
  allRows: PollRow[];
  width: number;
  height: number;
  detailTab: PollDetailTab;
  onDetailTabChange: (tab: PollDetailTab) => void;
}) {
  const tabs = (
    <Box paddingBottom={1}>
      <Tabs
        tabs={DETAIL_TABS}
        activeValue={detailTab}
        onSelect={(v) => onDetailTabChange(v as PollDetailTab)}
        compact
      />
    </Box>
  );

  const contentHeight = Math.max(height - 2, 1);

  if (detailTab === "trend") {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PollTrend poll={poll} allRows={allRows} width={width} height={contentHeight} />
      </Box>
    );
  }

  if (detailTab === "pollsters") {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PollPollsters poll={poll} allRows={allRows} width={width} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <PollOverview poll={poll} allRows={allRows} width={width} />
    </Box>
  );
}

export function PollsPane({ focused, width, height }: PaneProps) {
  const [tab, setTab] = useState<PollTabId>("approval");
  const [rowsByTab, setRowsByTab] = useState<Partial<Record<PollTabId, PollRow[]>>>({});
  // The mount effect loads immediately, so the first paint is a spinner rather
  // than a premature "No polls in this category".
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<PollDetailTab>("overview");
  const [sortPreference, setSortPreference] = useState<PollSortPreference>(DEFAULT_POLL_SORT);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const searchInputRef = useRef<InputRenderable | null>(null);
  const genRef = useRef(0);

  const allRows = rowsByTab[tab] ?? [];
  const filteredRows = useMemo(() => filterPollRows(allRows, searchQuery), [allRows, searchQuery]);
  const rows = useMemo(() => sortPollRows(filteredRows, sortPreference), [filteredRows, sortPreference]);
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((current) => current + 1);
  }, []);
  const blurSearch = useCallback(() => {
    setSearchFocused(false);
  }, []);

  const load = useCallback((pollType: PollTabId) => {
    genRef.current += 1;
    const gen = genRef.current;
    setStatus("loading");
    setError(null);
    fetchVoteHubPolls({ pollType })
      .then((polls) => {
        if (genRef.current !== gen) return;
        setRowsByTab((current) => ({
          ...current,
          [pollType]: polls.map(normalizeVoteHubPoll),
        }));
        setStatus("loaded");
        setLastUpdated(Date.now());
      })
      .catch((loadError) => {
        if (genRef.current !== gen) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    load(tab);
  }, [load, tab]);

  const refreshActiveTab = useCallback(() => {
    load(tab);
  }, [load, tab]);
  useAutoRefresh(status === "loaded" ? lastUpdated : null, refreshActiveTab);

  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      setDetailOpen(false);
      return;
    }
    if (!selectedId || !rows.some((row) => row.id === selectedId)) {
      setSelectedId(rows[0]!.id);
    }
  }, [rows, selectedId]);

  const openSelected = useCallback(() => {
    if (!selected?.url) return;
    openUrl(selected.url);
  }, [selected]);

  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    if (event.name === "/") {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusSearch();
      return true;
    }
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      load(tab);
      return true;
    }
    if (isPlainKey(event, "o")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (selected?.url) openUrl(selected.url);
      return true;
    }
    return false;
  }, [focusSearch, load, openSelected, selected?.url, tab]);

  useShortcut((event) => {
    if (!focused || detailOpen || searchFocused) return;
    if (event.name === "/") {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusSearch();
    }
  }, { enabled: focused && !detailOpen && !searchFocused });

  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "h") || event.name === "left") {
      event.preventDefault?.();
      event.stopPropagation?.();
      setDetailTab((current) => {
        const idx = DETAIL_TABS.findIndex((t) => t.value === current);
        if (idx <= 0) return DETAIL_TABS[DETAIL_TABS.length - 1]!.value;
        return DETAIL_TABS[idx - 1]!.value;
      });
      return true;
    }
    if (isPlainKey(event, "l") || event.name === "right") {
      event.preventDefault?.();
      event.stopPropagation?.();
      setDetailTab((current) => {
        const idx = DETAIL_TABS.findIndex((t) => t.value === current);
        if (idx < 0 || idx >= DETAIL_TABS.length - 1) return DETAIL_TABS[0]!.value;
        return DETAIL_TABS[idx + 1]!.value;
      });
      return true;
    }
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      load(tab);
      return true;
    }
    if (isPlainKey(event, "o")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (selected?.url) openUrl(selected.url);
      return true;
    }
    return false;
  }, [load, selected?.url, tab]);

  const columns = useMemo(() => createColumns(width), [width]);
  const updatedAgo = useUpdatedAgo(status === "loaded" ? lastUpdated : null);
  const renderCell = useCallback(
    (row: PollRow, column: PollColumn, _index: number, rowState: { selected: boolean }) =>
      renderPollCell(row, column, rowState.selected),
    [],
  );

  usePaneFooter("polls", () => ({
    info: [
      ...(status === "loading" ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(error ? [{ id: "error", parts: [{ text: "error", tone: "warning" as const }] }] : []),
      ...(updatedAgo ? [{ id: "updated", parts: [{ text: `updated ${updatedAgo}`, tone: "muted" as const }] }] : []),
    ],
    hints: detailOpen
      ? [{ id: "open", key: "o", label: "pen", onPress: openSelected, disabled: !selected?.url }]
      : [
          { id: "search", key: "/", label: "search", onPress: focusSearch },
          { id: "open", key: "o", label: "pen", onPress: openSelected, disabled: !selected?.url },
        ],
  }), [error, detailOpen, focusSearch, openSelected, selected?.url, status, updatedAgo]);

  const tabs = (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Tabs
        tabs={TABS}
        activeValue={tab}
        onSelect={(value) => {
          setTab(value as PollTabId);
          setDetailOpen(false);
          setSearchQuery("");
        }}
        compact
        variant="bare"
        focused={focused && !detailOpen && !searchFocused}
      />
    </Box>
  );

  const searchBar = (
    <InputSearchBar
      value={searchQuery}
      focused={focused && !detailOpen}
      active={searchFocused}
      width={width}
      focusToken={searchFocusToken}
      inputRef={searchInputRef}
      placeholder="subject or pollster"
      debounceMs={80}
      onFocus={focusSearch}
      onBlur={blurSearch}
      onNavigateDown={blurSearch}
      onQueryChange={setSearchQuery}
    />
  );

  if (allRows.length === 0 && (status === "loading" || error)) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PaneStatusBody loading={status === "loading"} error={error} subject="Polls" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <DataTableStackView<PollRow, PollColumn>
        focused={focused && !searchFocused}
        detailOpen={detailOpen && !!selected}
        onBack={() => setDetailOpen(false)}
        detailContent={
          selected ? (
            <PollDetail
              poll={selected}
              allRows={allRows}
              width={width}
              height={Math.max(height - 1, 1)}
              detailTab={detailTab}
              onDetailTabChange={setDetailTab}
            />
          ) : null
        }
        detailTitle={selected?.subject}
        rootBefore={searchBar}
        onRootKeyDown={handleRootKeyDown}
        onDetailKeyDown={handleDetailKeyDown}
        selection={{
          kind: "id",
          selectedId,
          getId: (row) => row.id,
          onChange: (id) => setSelectedId(id),
        }}
        onActivate={() => {
          blurSearch();
          setDetailOpen(true);
        }}
        rootWidth={width}
        rootHeight={Math.max(1, height - 1)}
        columns={columns}
        items={rows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={(columnId) => {
          const next = columnId as PollSortColumnId;
          setSortPreference((current) => nextStackSortPreference(
            current,
            next,
            next === "subject" || next === "pollster" || next === "pop" ? "asc" : "desc",
          ));
        }}
        getItemKey={(row) => row.id}
        renderCell={renderCell}
        emptyStateTitle={searchQuery.trim() ? "No matching polls." : "No polls in this category."}
        emptyStateHint={searchQuery.trim() ? "Clear search." : undefined}
      />
    </Box>
  );
}
