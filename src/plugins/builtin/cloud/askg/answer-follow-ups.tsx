import { DesktopPaneLinkChip, TerminalPaneLinkChip } from "../../../../components/ui";
import { Box, useUiCapabilities } from "../../../../ui";

/** The key that asks each question, shown in its chip's square: `1`, `2`, `3`. */
export function followUpKey(index: number): string {
  return String(index + 1);
}

/**
 * The questions Ask Gloom suggests asking next, under the newest answer: each
 * the chip a pane shared in chat is, its key in the square and the question
 * beside it, one to a line. A press, or its key once the keyboard has left
 * the question field, asks it.
 */
export function AnswerFollowUps({
  questions,
  width,
  onAsk,
}: {
  questions: readonly string[];
  width: number;
  onAsk: (question: string) => void;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  if (questions.length === 0) return null;
  if (nativePaneChrome) {
    return (
      <Box
        flexDirection="column"
        paddingTop={1}
        data-gloom-role="askg-follow-ups"
        style={{ alignItems: "flex-start" }}
      >
        {questions.map((question, index) => (
          <DesktopPaneLinkChip
            key={question}
            content={{ title: question, detail: "", icon: followUpKey(index) }}
            variant="line"
            onOpen={() => onAsk(question)}
            tooltip={question}
            role="askg-follow-up-chip"
            linkKey={`follow-up:${followUpKey(index)}`}
          />
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingTop={1} width={width}>
      {questions.map((question, index) => (
        <Box key={question} flexDirection="row" height={1}>
          <TerminalPaneLinkChip
            content={{ title: question, detail: "", icon: followUpKey(index) }}
            width={width}
            onOpen={() => onAsk(question)}
          />
        </Box>
      ))}
    </Box>
  );
}
