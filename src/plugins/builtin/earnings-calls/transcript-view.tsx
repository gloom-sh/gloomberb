import { useMemo, type RefObject } from "react";
import { Spinner } from "../../../components";
import { colors } from "../../../theme/colors";
import {
  Box,
  ScrollBox,
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

/**
 * The terminal renderer does not wrap text on its own, so long paragraphs are
 * pre-wrapped into one fixed-height row per line. Desktop chrome wraps natively.
 */
function TextLines({
  text,
  width,
  color,
  attributes,
  nativePaneChrome,
}: {
  text: string | undefined;
  width: number;
  color: string;
  attributes?: number;
  nativePaneChrome: boolean;
}) {
  if (!text?.trim()) return null;
  if (nativePaneChrome) {
    return (
      <Text fg={color} attributes={attributes} wrapText width="100%" style={NATIVE_TEXT_STYLE}>
        {text}
      </Text>
    );
  }
  return wrapTextLines(text, width).map((line, index) => (
    <Box key={index} height={1}>
      <Text fg={color} attributes={attributes}>{line}</Text>
    </Box>
  ));
}

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
    <Box flexDirection="column" marginTop={1}>
      <Box height={1}>
        <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
          {title}
        </Text>
      </Box>
      <TextLines text={body} width={width} color={colors.text} nativePaneChrome={nativePaneChrome} />
    </Box>
  );
}

export function TranscriptView({
  transcript,
  loading,
  error,
  qaOnly,
  query,
  width,
  scrollRef,
}: {
  transcript: CloudEarningsTranscriptPayload | null;
  loading: boolean;
  error: string | null;
  qaOnly: boolean;
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
    const scoped = qaOnly ? all.filter((turn) => turn.isQa) : all;
    const needle = (query ?? "").trim().toLowerCase();
    if (!needle) return scoped;
    return scoped.filter((turn) =>
      `${turn.speaker} ${turn.company ?? ""} ${turn.text}`.toLowerCase().includes(needle),
    );
  }, [transcript, qaOnly, query]);

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
          <TextLines text={meta} width={bodyWidth} color={colors.textDim} nativePaneChrome={isNative} />

          <Section title="SUMMARY" body={transcript.summary ?? ""} width={bodyWidth} nativePaneChrome={isNative} />
          <Section title="WHAT STOOD OUT" body={transcript.notable ?? ""} width={bodyWidth} nativePaneChrome={isNative} />
          <Section title="ANALYSTS PRESSED ON" body={transcript.analystFocus ?? ""} width={bodyWidth} nativePaneChrome={isNative} />
          <Section title="GUIDANCE" body={transcript.guidance ?? ""} width={bodyWidth} nativePaneChrome={isNative} />
          <Section title="RISKS" body={transcript.riskFactors ?? ""} width={bodyWidth} nativePaneChrome={isNative} />

          {transcript.participants.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Box height={1}>
                <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
                  PARTICIPANTS
                </Text>
              </Box>
              {transcript.participants.map((participant) => (
                <TextLines
                  key={participant.name}
                  text={[participant.name, participant.role, participant.company]
                    .filter(Boolean)
                    .join("  ·  ")}
                  width={bodyWidth}
                  color={colors.text}
                  nativePaneChrome={isNative}
                />
              ))}
            </Box>
          )}

          <Box height={1} marginTop={1}>
            <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
              {qaOnly ? "QUESTION AND ANSWER" : "TRANSCRIPT"}
            </Text>
          </Box>

          {turns.map((turn, index) => (
            <Box key={`${turn.startSeconds}-${index}`} flexDirection="column" marginTop={1}>
              <Box height={1} flexDirection="row" gap={1} overflow="hidden">
                <Text fg={colors.textDim}>{formatTimestamp(turn.startSeconds)}</Text>
                <Text fg={speakerColor(turn)} attributes={TextAttributes.BOLD}>
                  {turn.speaker}
                </Text>
                {turnDetail(turn) && <Text fg={colors.textDim}>{turnDetail(turn)}</Text>}
              </Box>
              <TextLines text={turn.text} width={bodyWidth} color={colors.text} nativePaneChrome={isNative} />
            </Box>
          ))}

          {turns.length === 0 && (
            <TextLines
              text={
                query?.trim()
                  ? `Nothing matching "${query.trim()}" in this call.`
                  : "No question and answer section in this call."
              }
              width={bodyWidth}
              color={colors.textDim}
              nativePaneChrome={isNative}
            />
          )}
        </Box>
      </ScrollBox>
    </Box>
  );
}
