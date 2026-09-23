import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../../../api-client";
import {
  EmptyState,
  ExternalLinkText,
  PaneStatusBody,
  Prose,
  SectionHeading,
  usePaneFooter,
  type PaneFooterSegment,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { colors, hoverBg } from "../../../theme/colors";
import {
  Box,
  ScrollBox,
  Text,
  useRendererHost,
  useUiCapabilities,
  type ScrollBoxRenderable,
} from "../../../ui";
import { truncateToDisplayWidth } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { useBoundTicker, useTickerRequest } from "../shared/ticker-request";
import {
  buildFilingEventsFeed,
  resolveFeedScrollTop,
  type FilingEventEntry,
} from "./feed";

export const FILING_EVENTS_PANE_ID = "filing-events";

const MAX_PROSE_WIDTH = 100;
const loadFilingEvents = (symbol: string) => apiClient.getFilingEvents(symbol, 100);

/** One filing: when it was filed, what it was about, and what it said. */
function FilingEntry({
  entry,
  nativePaneChrome,
  onOpen,
  onSelect,
  proseWidth,
  selected,
}: {
  entry: FilingEventEntry;
  nativePaneChrome: boolean;
  onOpen: () => void;
  onSelect: () => void;
  proseWidth: number;
  selected: boolean;
}) {
  // Desktop chrome clips the row itself; the terminal has to be told where the
  // row ends, or a third item label runs off it mid-word.
  const items = nativePaneChrome
    ? entry.itemsLabel
    : truncateToDisplayWidth(entry.itemsLabel, Math.max(4, proseWidth - entry.filedLabel.length - 2));
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      backgroundColor={selected ? hoverBg(colors) : undefined}
      data-gloom-role="filing-event"
      data-gloom-row="true"
      data-gloom-interactive="true"
      onMouseDown={onSelect}
    >
      <Box height={1} width="100%" flexDirection="row" gap={2} overflow="hidden">
        <ExternalLinkText
          url={entry.docUrl}
          label={entry.filedLabel}
          color={selected ? colors.selectedText : colors.textDim}
          onOpen={onOpen}
        />
        <Text fg={selected ? colors.selectedText : entry.material ? colors.warning : colors.textDim}>
          {items}
        </Text>
      </Box>
      {entry.headline ? (
        <Prose text={entry.headline} width={proseWidth} color={colors.textBright} />
      ) : null}
      {entry.points.map((point) => (
        <Prose
          key={point}
          text={point}
          width={proseWidth}
          color={colors.text}
          prefix="• "
        />
      ))}
      {entry.people.map((person) => (
        <Prose
          key={`${person.name}-${person.detail}`}
          text={person.detail}
          width={proseWidth}
          color={colors.textDim}
          prefix={`${person.name}  `}
          prefixColor={colors.textBright}
        />
      ))}
    </Box>
  );
}

export function FilingEventsPane({
  focused,
  width,
}: {
  focused: boolean;
  width: number;
  height: number;
}) {
  const { symbol, exchange } = useBoundTicker();
  const ticker = symbol ? symbol.toUpperCase() : null;
  const nativePaneChrome = useUiCapabilities().nativePaneChrome === true;
  const rendererHost = useRendererHost();

  const { data, loading, error, reload } = useTickerRequest(loadFilingEvents, ticker, exchange);
  const events = data?.events ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (scrollBox) scrollBox.scrollTop = 0;
    setSelectedId(null);
  }, [ticker]);

  const bodyWidth = Math.max(12, width - 2);
  const proseWidth = Math.min(bodyWidth, MAX_PROSE_WIDTH);
  // Desktop chrome wraps the paragraphs itself, across the whole pane; the
  // terminal wraps at the reading width. Measuring against whichever is in use
  // keeps the entry offsets on the lines the reader actually sees.
  const feed = useMemo(
    () => buildFilingEventsFeed(events, nativePaneChrome ? bodyWidth : proseWidth),
    [bodyWidth, events, nativePaneChrome, proseWidth],
  );
  const selectedIndex = Math.max(
    0,
    feed.entries.findIndex((entry) => entry.id === selectedId),
  );
  const selected = feed.entries[selectedIndex] ?? null;

  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (!scrollBox?.viewport || !selected) return;
    scrollBox.scrollTop = resolveFeedScrollTop({
      entry: selected,
      scrollTop: scrollBox.scrollTop,
      viewportHeight: scrollBox.viewport.height,
    });
  }, [selected]);

  const openFiling = useCallback(() => {
    if (selected?.docUrl) void rendererHost.openExternal(selected.docUrl);
  }, [rendererHost, selected]);

  const moveSelection = useCallback((delta: number) => {
    const entries = feed.entries;
    if (entries.length === 0) return;
    const next = Math.max(0, Math.min(entries.length - 1, selectedIndex + delta));
    setSelectedId(entries[next]?.id ?? null);
  }, [feed.entries, selectedIndex]);

  useShortcut(
    (event) => {
      if (isPlainKey(event, "r")) void reload();
      else if (isPlainKey(event, "o")) openFiling();
      else if (isPlainKey(event, "j", "down")) moveSelection(1);
      else if (isPlainKey(event, "k", "up")) moveSelection(-1);
    },
    { enabled: focused, scope: FILING_EVENTS_PANE_ID },
  );

  usePaneFooter(FILING_EVENTS_PANE_ID, () => {
    const info: PaneFooterSegment[] = [];
    if (loading) {
      info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    }
    if (error && ticker) info.push({ id: "error", parts: [{ text: error, tone: "warning" }] });
    const hints = selected
      ? [{ id: "open", key: "o", label: "pen filing", onPress: openFiling }]
      : [];
    return { info, hints };
  }, [loading, error, ticker, selected, openFiling]);

  if (!ticker) return <EmptyState title="Pick a ticker to see its 8-K filings." />;
  if (loading && !data) {
    return <PaneStatusBody loading align="center" loadingLabel="Loading 8-Ks..." />;
  }
  if (error && !data) {
    return (
      <PaneStatusBody
        error={error ?? "Could not load 8-K filings."}
        errorTitle="Could not load 8-K filings."
      />
    );
  }
  if (data && events.length === 0) {
    return (
      <EmptyState title={`No 8-K on file for ${ticker} in the last six months.`} />
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
      <ScrollBox
        ref={scrollRef}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
        scrollY
        focusable={false}
        paddingX={1}
      >
        <Box
          flexDirection="column"
          width={nativePaneChrome ? "100%" : bodyWidth}
        >
          {feed.sections.map((section, index) => (
            <Box key={section.id} flexDirection="column">
              <SectionHeading marginTop={index === 0 ? 0 : 1} title={section.title} />
              {section.entries.map((entry) => (
                <FilingEntry
                  key={entry.id}
                  entry={entry}
                  nativePaneChrome={nativePaneChrome}
                  onOpen={() => {
                    setSelectedId(entry.id);
                    void rendererHost.openExternal(entry.docUrl);
                  }}
                  onSelect={() => setSelectedId(entry.id)}
                  proseWidth={proseWidth}
                  selected={entry.id === selected?.id}
                />
              ))}
            </Box>
          ))}

        </Box>
      </ScrollBox>
    </Box>
  );
}
