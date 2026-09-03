import { useMemo, type RefObject } from "react";
import { Spinner } from "../../../components";
import { Tabs } from "../../../components/ui/tabs";
import { colors } from "../../../theme/colors";
import {
  Box,
  ScrollBox,
  StyledText,
  Text,
  TextAttributes,
  useUiCapabilities,
  type ScrollBoxRenderable,
} from "../../../ui";
import { wrapTextLines } from "../../../utils/text-wrap";
import type {
  CloudEarningsTranscriptPayload,
  CloudTranscriptTurnPayload,
} from "../../../api-client";
import { formatCallDate, formatDuration, formatSentiment, formatTimestamp } from "./format";
import { splitFigures, splitSentences } from "./prose";

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

const NATIVE_STRETCH_STYLE = { minWidth: 0 };
const NATIVE_TEXT_STYLE = { display: "block" };

/** Figures set in bold, the rest in the given colour. */
function styledRuns(text: string, color: string, attributes = 0): StyledText {
  return new StyledText(
    splitFigures(text).map((run) => ({
      text: run.text,
      fg: run.figure ? colors.textBright : color,
      attributes: run.figure ? attributes | TextAttributes.BOLD : attributes,
    })),
  );
}

/**
 * A paragraph with figures in bold. The terminal renderer does not wrap on
 * its own, so lines are pre-wrapped and styled one at a time; desktop
 * chrome wraps the styled paragraph itself. `indent` is applied to every
 * line after the first, for bullets.
 */
function Prose({
  text,
  width,
  color,
  nativePaneChrome,
  prefix = "",
}: {
  text: string;
  width: number;
  color: string;
  nativePaneChrome: boolean;
  /** Put before the first line; later lines are indented by its width. */
  prefix?: string;
}) {
  if (!text.trim()) return null;
  if (nativePaneChrome) {
    return (
      <Box flexDirection="row" width="100%" style={NATIVE_STRETCH_STYLE}>
        {prefix ? <Text fg={colors.textDim}>{prefix}</Text> : null}
        <Text
          wrapText
          width="100%"
          style={NATIVE_TEXT_STYLE}
          content={styledRuns(text, color)}
        />
      </Box>
    );
  }
  const indent = " ".repeat(prefix.length);
  return wrapTextLines(text, Math.max(8, width - prefix.length)).map((line, index) => (
    <Box key={index} height={1} flexDirection="row">
      {prefix ? (
        <Text fg={colors.textDim} flexShrink={0}>
          {index === 0 ? prefix : indent}
        </Text>
      ) : null}
      <Text content={styledRuns(line, color)} />
    </Box>
  ));
}

function SectionHeading({ title }: { title: string }) {
  return (
    <Box height={1} marginTop={1}>
      <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
        {title}
      </Text>
    </Box>
  );
}

/** A summary section as one point per sentence. */
function Section({
  title,
  body,
  width,
  nativePaneChrome,
}: {
  title: string;
  body: string;
  width: number;
  nativePaneChrome: boolean;
}) {
  if (!body.trim()) return null;
  return (
    <Box flexDirection="column">
      <SectionHeading title={title} />
      {splitSentences(body).map((sentence, index) => (
        <Prose
          key={index}
          text={sentence}
          width={width}
          color={colors.text}
          nativePaneChrome={nativePaneChrome}
          prefix="• "
        />
      ))}
    </Box>
  );
}

function TurnView({
  turn,
  width,
  nativePaneChrome,
}: {
  turn: CloudTranscriptTurnPayload;
  width: number;
  nativePaneChrome: boolean;
}) {
  const detail = turnDetail(turn);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box height={1} flexDirection="row" gap={1} overflow="hidden">
        <Text fg={colors.textDim}>{formatTimestamp(turn.startSeconds)}</Text>
        <Text fg={speakerColor(turn)} attributes={TextAttributes.BOLD}>
          {turn.speaker}
        </Text>
        {detail ? <Text fg={colors.textDim}>{detail}</Text> : null}
      </Box>
      <Prose text={turn.text} width={width} color={colors.text} nativePaneChrome={nativePaneChrome} />
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

  const turns = useMemo(() => {
    const all = transcript?.turns ?? [];
    const scoped = tab === "qa" ? all.filter((turn) => turn.isQa) : all;
    const needle = (query ?? "").trim().toLowerCase();
    if (!needle) return scoped;
    return scoped.filter((turn) =>
      `${turn.speaker} ${turn.company ?? ""} ${turn.text}`.toLowerCase().includes(needle),
    );
  }, [transcript, tab, query]);

  if (loading && !transcript) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Spinner label="Loading transcript..." />
      </Box>
    );
  }

  if (error && !transcript) {
    return (
      <Box flexGrow={1} paddingX={1}>
        <Text fg={colors.negative}>{error}</Text>
      </Box>
    );
  }

  if (!transcript) return null;

  // The stack title already names ticker and period, so lead with metadata.
  const meta = [
    formatCallDate(transcript.callAt),
    formatDuration(transcript.durationSeconds),
    transcript.participants.length > 0 ? `${transcript.participants.length} speakers` : null,
    transcript.sentiment !== null ? `sentiment ${formatSentiment(transcript.sentiment)}` : null,
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
              <Prose text={meta} width={proseWidth} color={colors.textDim} nativePaneChrome={isNative} />
              <Section title="SUMMARY" body={transcript.summary ?? ""} width={proseWidth} nativePaneChrome={isNative} />
              <Section title="WHAT STOOD OUT" body={transcript.notable ?? ""} width={proseWidth} nativePaneChrome={isNative} />
              <Section title="ANALYSTS PRESSED ON" body={transcript.analystFocus ?? ""} width={proseWidth} nativePaneChrome={isNative} />
              <Section title="GUIDANCE" body={transcript.guidance ?? ""} width={proseWidth} nativePaneChrome={isNative} />
              <Section title="RISKS" body={transcript.riskFactors ?? ""} width={proseWidth} nativePaneChrome={isNative} />
              {transcript.participants.length > 0 && (
                <Box flexDirection="column">
                  <SectionHeading title="PARTICIPANTS" />
                  {transcript.participants.map((participant) => (
                    <Prose
                      key={participant.name}
                      text={[participant.name, participant.role, participant.company]
                        .filter(Boolean)
                        .join("  ·  ")}
                      width={proseWidth}
                      color={colors.text}
                      nativePaneChrome={isNative}
                    />
                  ))}
                </Box>
              )}
            </>
          ) : (
            <>
              {turns.map((turn, index) => (
                <TurnView
                  key={`${turn.startSeconds}-${index}`}
                  turn={turn}
                  width={proseWidth}
                  nativePaneChrome={isNative}
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
                    nativePaneChrome={isNative}
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
