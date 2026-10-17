import { memo, useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type {
  CloudEarningsTranscriptPayload,
  CloudTranscriptTurnPayload,
} from "../../../api-client";
import {
  BulletList,
  FigureList,
  PaneStatusBody,
  Prose,
  QueryBar,
  READING_WIDTH,
  SectionHeading,
  type QueryBarSearch,
} from "../../../components";
import { PlaybackLine } from "../../../components/ui";
import { afterLayout, revealInScrollBox } from "../../../components/ui/reveal-in-scroll-box";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import {
  Box,
  ScrollBox,
  Text,
  TextAttributes,
  useUiCapabilities,
  type BoxRenderable,
  type ScrollBoxRenderable,
} from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import {
  formatCallDate,
  formatDuration,
  formatSentiment,
  formatTimestamp,
} from "./format";
import {
  buildTranscriptSegments,
  filterTranscriptTurns,
  turnParagraphs,
  type TranscriptLine,
  type TranscriptMatch,
} from "./model";
import { splitSentences } from "./prose";

export type ReaderTab = "summary" | "transcript" | "qa";

/** `hint` is the key that jumps to the section, shown on its chip. */
export const READER_TABS: Array<{ label: string; value: ReaderTab; hint: string }> = [
  { label: "Summary", value: "summary", hint: "s" },
  { label: "Transcript", value: "transcript", hint: "t" },
  { label: "Q&A", value: "qa", hint: "q" },
];

const NATIVE_STRETCH_STYLE = { minWidth: 0 };
/** After the reader scrolls by hand, playback leaves the view where it is for this long. */
const FOLLOW_PAUSE_MS = 5_000;
/** A scroll this soon after the reader moved itself is that move, not the user's. */
const OWN_SCROLL_MS = 300;
/** The line being heard, or a find's match, lands this far down the view. */
const READ_ANCHOR = 0.25;

const lineKey = (turn: number, paragraph: number) => `${turn}:${paragraph}`;

/** Playing the call beside its transcript: where each paragraph starts and which one is heard. */
export interface TranscriptPlayback {
  /** By turn of the whole transcript, then paragraph; null where a line has no time. */
  starts: ReadonlyArray<ReadonlyArray<number | null>>;
  current: TranscriptLine | null;
  onPlay: (seconds: number) => void;
}

/** A find that marks its matches and steps through them, rather than narrowing the turns. */
export interface TranscriptFind {
  query: string;
  active: TranscriptMatch | null;
}

function speakerColor(turn: CloudTranscriptTurnPayload): string {
  if (turn.speaker === "Operator") return colors.textDim;
  if (turn.role === "Analyst") return colors.warning;
  return colors.textBright;
}

/** Role and firm after the name; "Operator" is not repeated as its own role. */
function turnDetail(turn: CloudTranscriptTurnPayload): string {
  const role = turn.role && turn.role !== turn.speaker ? turn.role : null;
  return [role, turn.company].filter(Boolean).join(", ");
}

/** A summary section as one point per sentence. */
function Section({
  title,
  body,
  width,
}: {
  title: string;
  body: string;
  width: number;
}) {
  if (!body.trim()) return null;
  return (
    <Box flexDirection="column">
      <SectionHeading marginTop={1} title={title} />
      <BulletList items={splitSentences(body)} width={width} color={colors.text} />
    </Box>
  );
}

const TurnView = memo(function TurnView({
  turn,
  turnIndex,
  width,
  starts,
  currentParagraph = null,
  onPlay,
  markQuery,
  activeMatch = null,
  registerLine,
}: {
  turn: CloudTranscriptTurnPayload;
  /** The turn's place in the whole transcript, which names its lines. */
  turnIndex: number;
  width: number;
  starts?: ReadonlyArray<number | null>;
  currentParagraph?: number | null;
  onPlay?: (seconds: number) => void;
  markQuery?: string;
  /** The find's match, when it is in this turn. */
  activeMatch?: TranscriptMatch | null;
  registerLine?: (key: string, node: BoxRenderable | null) => void;
}) {
  const detail = turnDetail(turn);
  // The server cuts paragraphs where the speaker paused on the recording.
  // A transcript from before that is one block, so it is cut here by length.
  const paragraphs = turnParagraphs(turn);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box height={1} flexDirection="row" gap={1} overflow="hidden">
        {/* A transcript the company published as a document has no timings. */}
        {turn.startSeconds !== null && (
          <Text fg={colors.textDim}>{formatTimestamp(turn.startSeconds)}</Text>
        )}
        <Text fg={speakerColor(turn)} attributes={TextAttributes.BOLD}>
          {turn.speaker}
        </Text>
        {detail ? <Text fg={colors.textDim}>{detail}</Text> : null}
      </Box>
      {paragraphs.map((paragraph, index) => (
        <PlaybackLine
          key={index}
          marginTop={index === 0 ? 0 : 1}
          start={starts?.[index] ?? null}
          current={currentParagraph === index}
          onPlay={onPlay}
          nodeRef={registerLine ? (node) => registerLine(lineKey(turnIndex, index), node) : undefined}
        >
          <Prose
            text={paragraph}
            width={width}
            color={colors.text}
            marks={markQuery ? { query: markQuery, active: activeMatch?.paragraph === index ? activeMatch.occurrence : null } : undefined}
          />
        </PlaybackLine>
      ))}
    </Box>
  );
});

export function TranscriptView({
  transcript,
  loading,
  error,
  tab,
  onTabChange,
  tabsFocused,
  query,
  search,
  width,
  scrollRef,
  find,
  playback,
}: {
  transcript: CloudEarningsTranscriptPayload | null;
  loading: boolean;
  error: string | null;
  tab: ReaderTab;
  onTabChange: (tab: ReaderTab) => void;
  /** Whether left/right should move between tabs. */
  tabsFocused: boolean;
  /** Free-text filter applied to the turns, for finding a topic in a long call. */
  query?: string;
  /** The find field, drawn in the reader's bar beside the section switch. */
  search?: QueryBarSearch;
  width: number;
  /** Lets the owning pane drive keyboard scrolling. */
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  /** Marks and steps through matches instead of narrowing to them by `query`. */
  find?: TranscriptFind;
  /** The call's recording: lines play from where they start and the one heard is marked and followed. */
  playback?: TranscriptPlayback;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const isNative = nativePaneChrome === true;

  // Each shown turn with its place in the whole transcript, which names its
  // lines for playback and find whatever the section shows.
  const turns = useMemo(() => {
    const all = transcript?.turns ?? [];
    const shown = new Set(filterTranscriptTurns(all, {
      section: tab === "qa" ? "qa" : "transcript",
      search: query,
    }));
    return all.flatMap((turn, index) => (shown.has(turn) ? [{ turn, index }] : []));
  }, [transcript, tab, query]);

  const ownScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const setScrollBox = useCallback((node: ScrollBoxRenderable | null) => {
    ownScrollRef.current = node;
    if (scrollRef) (scrollRef as { current: ScrollBoxRenderable | null }).current = node;
  }, [scrollRef]);
  const lineNodes = useRef(new Map<string, BoxRenderable>());
  const registerLine = useCallback((key: string, node: BoxRenderable | null) => {
    if (node) lineNodes.current.set(key, node);
    else lineNodes.current.delete(key);
  }, []);
  const userScrolledAt = useRef(0);
  const movedAt = useRef(0);
  const reveal = useCallback((line: TranscriptLine) => afterLayout(() => {
    movedAt.current = Date.now();
    revealInScrollBox(ownScrollRef.current, lineNodes.current.get(lineKey(line.turn, line.paragraph)) ?? null, { anchor: READ_ANCHOR });
  }), []);
  const onScrollActivity = useCallback(() => {
    if (Date.now() - movedAt.current > OWN_SCROLL_MS) userScrolledAt.current = Date.now();
  }, []);

  // The line being heard stays in view, unless the reader has just scrolled
  // away from it to read something else.
  const current = playback?.current ?? null;
  const currentKey = current ? lineKey(current.turn, current.paragraph) : null;
  useEffect(() => {
    if (!current || Date.now() - userScrolledAt.current < FOLLOW_PAUSE_MS) return;
    return reveal(current);
    // The line, not the object that names it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, tab, reveal]);

  // Stepping the find brings its match into view and holds playback off it.
  const activeMatch = find?.active ?? null;
  const matchKey = activeMatch ? `${lineKey(activeMatch.turn, activeMatch.paragraph)}:${activeMatch.occurrence}` : null;
  useEffect(() => {
    if (!activeMatch) return;
    userScrolledAt.current = Date.now();
    return reveal(activeMatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, reveal]);

  const playFrom = playback?.onPlay;
  const onPlay = useCallback((seconds: number) => {
    // Choosing a line hands the view back to playback.
    userScrolledAt.current = 0;
    playFrom?.(seconds);
  }, [playFrom]);
  const fullTextSegments = useMemo(() => (
    transcript && tab === "transcript" && !transcript.turns?.length
      ? buildTranscriptSegments(transcript, "transcript", { search: query }) : []
  ), [transcript, tab, query]);
  const hasQa = (transcript?.turns ?? []).some((turn) => turn.isQa);
  const readerTabs = READER_TABS.map((entry) => ({
    label: entry.label,
    value: entry.value,
    hint: entry.hint,
    disabled: entry.value === "qa" && !hasQa,
  }));

  // Scoped: inside a ticker research tab the tab strip also answers h/l and
  // registered first. A scoped handler runs ahead of unscoped ones in its
  // phase, so an open call keeps h/l for its sections.
  // With a recording the arrows seek it, and h and l alone move between sections.
  useShortcut((event) => {
    if (!tabsFocused || !transcript) return;
    const direction = isPlainKey(event, "h", ...(playback ? [] : ["left"])) ? -1
      : isPlainKey(event, "l", ...(playback ? [] : ["right"])) ? 1 : 0;
    if (!direction) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    const enabled = readerTabs.filter((entry) => !entry.disabled);
    const index = enabled.findIndex((entry) => entry.value === tab);
    const next = index < 0
      ? enabled[direction > 0 ? 0 : enabled.length - 1]
      : enabled[Math.max(0, Math.min(enabled.length - 1, index + direction))];
    if (next && next.value !== tab) onTabChange(next.value);
  }, { enabled: tabsFocused && !!transcript, scope: "earnings-calls:reader" });

  if (loading && !transcript) {
    return (
      <PaneStatusBody loading align="center" loadingLabel="Loading transcript..." />
    );
  }

  if (error && !transcript) {
    return (
      <PaneStatusBody error={error} />
    );
  }

  if (!transcript) return null;

  // The stack title already names ticker and period, so lead with metadata.
  const meta = [
    formatCallDate(transcript.callAt),
    formatDuration(transcript.durationSeconds),
    transcript.sentiment !== null
      ? `sentiment ${formatSentiment(transcript.sentiment)}`
      : null,
  ]
    .filter(Boolean)
    .join("  ·  ");

  // One column of padding each side inside the scroll box.
  const bodyWidth = Math.max(12, width - 2);
  const proseWidth = Math.min(bodyWidth, READING_WIDTH);
  const contentWidth = isNative ? "100%" : bodyWidth;
  const contentStyle = isNative ? NATIVE_STRETCH_STYLE : undefined;

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minHeight={0}
      overflow="hidden"
    >
      <QueryBar
        width={width}
        search={search}
        filters={[{
          id: "section",
          label: "Show",
          inline: true,
          value: tab,
          options: readerTabs,
          onChange: (value: string) => onTabChange(value as ReaderTab),
        }]}
      />
      <ScrollBox
        ref={setScrollBox}
        {...(playback || find ? { onMouseScroll: onScrollActivity } : {})}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
        scrollY
        focusable={false}
        paddingX={1}
      >
        <Box flexDirection="column" width={contentWidth} style={contentStyle}>
          {tab === "summary" ? (
            <>
              <Prose
                text={meta}
                width={proseWidth}
                color={colors.textDim}
              />
              {transcript.keyFigures?.length ? (
                <Box flexDirection="column">
                  <SectionHeading marginTop={1} title="Key Figures" />
                  <FigureList figures={transcript.keyFigures} width={proseWidth} />
                </Box>
              ) : null}
              <Section
                title="Summary"
                body={transcript.summary ?? ""}
                width={proseWidth}
              />
              <Section
                title="What Stood Out"
                body={transcript.notable ?? ""}
                width={proseWidth}
              />
              <Section
                title="Analysts Pressed On"
                body={transcript.analystFocus ?? ""}
                width={proseWidth}
              />
              <Section
                title="Guidance"
                body={transcript.guidance ?? ""}
                width={proseWidth}
              />
              <Section
                title="Risks"
                body={transcript.riskFactors ?? ""}
                width={proseWidth}
              />
              {transcript.participants.length > 0 && (
                <Box flexDirection="column">
                  <SectionHeading marginTop={1} title="Participants" />
                  {transcript.participants.map((participant) => (
                    <Prose
                      key={participant.name}
                      text={[
                        participant.name,
                        participant.role,
                        participant.company,
                      ]
                        .filter(Boolean)
                        .join("  ·  ")}
                      width={proseWidth}
                      color={colors.text}
                    />
                  ))}
                </Box>
              )}
            </>
          ) : (
            <>
              {turns.map(({ turn, index: turnIndex }, index) => (
                <TurnView
                  key={`${turn.startSeconds ?? "doc"}-${index}`}
                  turn={turn}
                  turnIndex={turnIndex}
                  width={proseWidth}
                  starts={playback?.starts[turnIndex]}
                  currentParagraph={current?.turn === turnIndex ? current.paragraph : null}
                  onPlay={playback ? onPlay : undefined}
                  markQuery={find?.query.trim() || undefined}
                  activeMatch={activeMatch?.turn === turnIndex ? activeMatch : null}
                  registerLine={playback || find ? registerLine : undefined}
                />
              ))}
              {fullTextSegments.map((segment) => (
                <Box key={segment.index} marginTop={1}>
                  <Prose text={segment.text} width={proseWidth} color={colors.text} />
                </Box>
              ))}
              {turns.length === 0 && fullTextSegments.length === 0 && (
                <Box marginTop={1}>
                  <Prose
                    text={
                      query?.trim()
                        ? `Nothing matching "${query.trim()}" in this call.`
                        : tab === "qa" ? "No question and answer section in this call."
                          : "Transcript text is unavailable."
                    }
                    width={proseWidth}
                    color={colors.textDim}
                  />
                </Box>
              )}
            </>
          )}
        </Box>
      </ScrollBox>
    </Box>
  );
}
