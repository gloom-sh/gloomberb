import { useMemo } from "react";
import { Spinner } from "../../../components";
import { colors } from "../../../theme/colors";
import { Box, ScrollBox, Text, TextAttributes } from "../../../ui";
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

function Section({ title, body }: { title: string; body: string }) {
  if (!body.trim()) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
        {title}
      </Text>
      <Text fg={colors.text}>{body}</Text>
    </Box>
  );
}

export function TranscriptView({
  transcript,
  loading,
  error,
  qaOnly,
  width,
}: {
  transcript: CloudEarningsTranscriptPayload | null;
  loading: boolean;
  error: string | null;
  qaOnly: boolean;
  width: number;
}) {
  const turns = useMemo(() => {
    const all = transcript?.turns ?? [];
    return qaOnly ? all.filter((turn) => turn.isQa) : all;
  }, [transcript, qaOnly]);

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

  const bodyWidth = Math.max(20, width - 2);

  return (
    <ScrollBox scrollY flexGrow={1} paddingX={1}>
      <Box flexDirection="column" width={bodyWidth}>
        <Text fg={colors.textDim}>{meta}</Text>

        <Section title="SUMMARY" body={transcript.summary ?? ""} />
        <Section title="WHAT STOOD OUT" body={transcript.notable ?? ""} />
        <Section title="ANALYSTS PRESSED ON" body={transcript.analystFocus ?? ""} />
        <Section title="GUIDANCE" body={transcript.guidance ?? ""} />
        <Section title="RISKS" body={transcript.riskFactors ?? ""} />

        {transcript.participants.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
              PARTICIPANTS
            </Text>
            {transcript.participants.map((participant) => (
              <Text key={participant.name} fg={colors.text}>
                {[participant.name, participant.role, participant.company]
                  .filter(Boolean)
                  .join("  ·  ")}
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
            {qaOnly ? "QUESTION AND ANSWER" : "TRANSCRIPT"}
          </Text>
        </Box>

        {turns.map((turn, index) => (
          <Box key={`${turn.startSeconds}-${index}`} flexDirection="column" marginTop={1}>
            <Box flexDirection="row" gap={1}>
              <Text fg={colors.textDim}>{formatTimestamp(turn.startSeconds)}</Text>
              <Text fg={speakerColor(turn)} attributes={TextAttributes.BOLD}>
                {turn.speaker}
              </Text>
              {(turn.role || turn.company) && (
                <Text fg={colors.textDim}>
                  {[turn.role, turn.company].filter(Boolean).join(", ")}
                </Text>
              )}
            </Box>
            <Text fg={colors.text}>{turn.text}</Text>
          </Box>
        ))}

        {turns.length === 0 && (
          <Text fg={colors.textDim}>No question and answer section in this call.</Text>
        )}
      </Box>
    </ScrollBox>
  );
}
