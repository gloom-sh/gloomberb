import { useMemo, type RefObject } from "react";
import type {
  CloudEarningsTranscriptPayload,
  CloudTranscriptKeyFigurePayload,
  CloudTranscriptTurnPayload,
} from "../../../api-client";
import { PaneStatusBody, Prose, SectionHeading } from "../../../components";
import { Tabs } from "../../../components/ui/tabs";
import { colors } from "../../../theme/colors";
import {
  Box,
  ScrollBox,
  Text,
  TextAttributes,
  useUiCapabilities,
  type ScrollBoxRenderable,
} from "../../../ui";
import {
  formatCallDate,
  formatDuration,
  formatSentiment,
  formatTimestamp,
} from "./format";
import { filterTranscriptTurns } from "./model";
import { splitParagraphs, splitSentences } from "./prose";

export type ReaderTab = "summary" | "transcript" | "qa";

export const READER_TABS: Array<{ label: string; value: ReaderTab }> = [
  { label: "Summary", value: "summary" },
  { label: "Transcript", value: "transcript" },
  { label: "Q&A", value: "qa" },
];

/**
 * Prose is capped at a comfortable measure. On a wide pane a full-width line
 * is over two hundred characters, which the eye loses on the way back.
 */
const MAX_PROSE_WIDTH = 100;
const NATIVE_STRETCH_STYLE = { minWidth: 0 };

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
      {splitSentences(body).map((sentence, index) => (
        <Prose
          key={index}
          text={sentence}
          width={width}
          color={colors.text}
          prefix="• "
        />
      ))}
    </Box>
  );
}

/**
 * The numbers management gave, one per line with the value first so the
 * column of figures is what the eye lands on.
 */
function KeyFigures({
  figures,
  width,
}: {
  figures: CloudTranscriptKeyFigurePayload[];
  width: number;
}) {
  if (figures.length === 0) return null;
  const valueWidth = Math.min(
    18,
    Math.max(...figures.map((figure) => figure.value.length)),
  );
  return (
    <Box flexDirection="column">
      <SectionHeading marginTop={1} title="KEY FIGURES" />
      {figures.map((figure) => {
        const value =
          figure.value.length > valueWidth
            ? figure.value
            : figure.value.padEnd(valueWidth);
        const rest = [figure.label, figure.note].filter(Boolean).join(", ");
        return (
          <Prose
            key={`${figure.label}-${figure.value}`}
            text={rest}
            width={width}
            color={colors.textDim}
            prefix={`${value}  `}
            prefixColor={colors.textBright}
          />
        );
      })}
    </Box>
  );
}

function TurnView({
  turn,
  width,
}: {
  turn: CloudTranscriptTurnPayload;
  width: number;
}) {
  const detail = turnDetail(turn);
  // The server cuts paragraphs where the speaker paused on the recording.
  // A transcript from before that is one block, so it is cut here by length.
  const paragraphs =
    turn.paragraphs && turn.paragraphs.length > 0
      ? turn.paragraphs
      : splitParagraphs(turn.text);
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
        <Box key={index} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
          <Prose
            text={paragraph}
            width={width}
            color={colors.text}
          />
        </Box>
      ))}
    </Box>
  );
}

export function TranscriptView({
  transcript,
  loading,
  error,
  tab,
  onTabChange,
  tabsFocused,
  query,
  width,
  scrollRef,
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
  width: number;
  /** Lets the owning pane drive keyboard scrolling. */
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const isNative = nativePaneChrome === true;

  const turns = useMemo(
    () =>
      filterTranscriptTurns(transcript?.turns ?? [], {
        section: tab === "qa" ? "qa" : "transcript",
        search: query,
      }),
    [transcript, tab, query],
  );

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
    transcript.participants.length > 0
      ? `${transcript.participants.length} speakers`
      : null,
    transcript.sentiment !== null
      ? `sentiment ${formatSentiment(transcript.sentiment)}`
      : null,
  ]
    .filter(Boolean)
    .join("  ·  ");

  // One column of padding each side inside the scroll box.
  const bodyWidth = Math.max(12, width - 2);
  const proseWidth = Math.min(bodyWidth, MAX_PROSE_WIDTH);
  const contentWidth = isNative ? "100%" : bodyWidth;
  const contentStyle = isNative ? NATIVE_STRETCH_STYLE : undefined;
  const hasQa = (transcript.turns ?? []).some((turn) => turn.isQa);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minHeight={0}
      overflow="hidden"
    >
      <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
        <Tabs
          tabs={READER_TABS.map((entry) => ({
            label: entry.label,
            value: entry.value,
            disabled: entry.value === "qa" && !hasQa,
          }))}
          activeValue={tab}
          onSelect={(value) => onTabChange(value as ReaderTab)}
          compact
          variant="bare"
          focused={tabsFocused}
        />
      </Box>
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
        <Box flexDirection="column" width={contentWidth} style={contentStyle}>
          {tab === "summary" ? (
            <>
              <Prose
                text={meta}
                width={proseWidth}
                color={colors.textDim}
              />
              <KeyFigures
                figures={transcript.keyFigures ?? []}
                width={proseWidth}
              />
              <Section
                title="SUMMARY"
                body={transcript.summary ?? ""}
                width={proseWidth}
              />
              <Section
                title="WHAT STOOD OUT"
                body={transcript.notable ?? ""}
                width={proseWidth}
              />
              <Section
                title="ANALYSTS PRESSED ON"
                body={transcript.analystFocus ?? ""}
                width={proseWidth}
              />
              <Section
                title="GUIDANCE"
                body={transcript.guidance ?? ""}
                width={proseWidth}
              />
              <Section
                title="RISKS"
                body={transcript.riskFactors ?? ""}
                width={proseWidth}
              />
              {transcript.participants.length > 0 && (
                <Box flexDirection="column">
                  <SectionHeading marginTop={1} title="PARTICIPANTS" />
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
              {turns.map((turn, index) => (
                <TurnView
                  key={`${turn.startSeconds ?? "doc"}-${index}`}
                  turn={turn}
                  width={proseWidth}
                />
              ))}
              {turns.length === 0 && (
                <Box marginTop={1}>
                  <Prose
                    text={
                      query?.trim()
                        ? `Nothing matching "${query.trim()}" in this call.`
                        : "No question and answer section in this call."
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
