import { useEffect, useState } from "react";
import { Spinner, Prose } from "../../../../components";
import { quoteBlockStyle, terminalAccentTint } from "../../../../components/ui/quote";
import { useThemeColors } from "../../../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../../../ui";
import type { ASKGTurn } from "./model";

/**
 * The question as it was asked, set apart from the answer under it as a
 * quote is: a rule down its left edge in the accent and a faint band of it.
 * Gloom's answer is the plain text that follows, so who said what reads at
 * a glance, in a live conversation and in a stored one alike.
 */
export function TurnQuestion({ text, width }: { text: string; width: number }) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  if (!text.trim()) return null;
  if (nativePaneChrome) {
    return (
      <Box data-gloom-role="askg-question" data-gloom-selectable="true" style={quoteBlockStyle()}>
        <Prose text={text} width={width} color={colors.textBright} figures={false} />
      </Box>
    );
  }
  // The rule takes the first column and a space keeps the text off it.
  return (
    <Box
      width={width}
      border={["left"]}
      borderStyle="heavy"
      borderColor={colors.borderFocused}
      backgroundColor={terminalAccentTint(colors)}
      paddingLeft={1}
      paddingRight={1}
    >
      <Prose text={text} width={Math.max(10, width - 3)} color={colors.textBright} figures={false} />
    </Box>
  );
}

/** Whole seconds since `since`, counted up once a second while mounted. */
function useSecondsSince(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1_000));
}

/**
 * The line under an answer still coming in: the spinner, what Gloom is doing
 * and how long it has been at it. It stays through the whole turn (a server
 * read can take twenty seconds without a row to show for it), so the
 * conversation never sits still while Gloom works, and it goes when the
 * answer is done. A call waiting on the person's approval has its own prompt.
 */
export function TurnProgress({ turn }: { turn: ASKGTurn }) {
  const colors = useThemeColors();
  const seconds = useSecondsSince(turn.startedAt);
  if (turn.status !== "streaming") return null;
  if (turn.tools.some((row) => row.status === "awaiting-confirmation")) return null;
  const label = turn.answer.trim() ? "Gloom is writing…" : "Gloom is thinking…";
  return (
    <Box flexDirection="row" paddingTop={1} gap={2} data-gloom-role="askg-progress">
      <Spinner label={label} emphasized />
      {seconds > 0 ? <Text fg={colors.textDim}>{`${seconds} s`}</Text> : null}
    </Box>
  );
}
