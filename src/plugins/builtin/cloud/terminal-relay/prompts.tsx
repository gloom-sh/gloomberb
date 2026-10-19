import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useUiHost } from "../../../../ui";
import { Button } from "../../../../components/ui/button";
import { DialogActions } from "../../../../components/ui/dialog-actions";
import { DialogFrame } from "../../../../components/ui/frame";
import { t, tf } from "../../../../i18n";
import { RemoteUiScope } from "../../../../remote/semantic-tree";
import { useThemeColors } from "../../../../theme/theme-context";
import { type DialogApi, type PromptContext, useDialogKeyboard } from "../../../../ui/dialog";
import { isPlainKey } from "../../../../utils/keyboard";
import type { AssistantDecision } from "./grants";
import { CONFIRM_WINDOW_MS, RELAY_PROMPT_SCOPE, type ApprovalAnswer, type ConfirmationAnswer, type RelayCaller, type RelayPrompts } from "./engine";
import type { CallSummary } from "./summary";
import { logFailure } from "../../../../utils/log-failure";

const WIDTH = 56;
/** Keys typed just before a prompt appeared do not answer it. */
const KEY_GRACE_MS = 600;

/** A fixed width in the terminal; on the desktop and the web, up to it, so a phone fits. */
function usePromptWidth(): { width: number | string; maxWidth?: number } {
  return useUiHost().kind === "opentui" ? { width: WIDTH } : { width: "100%", maxWidth: WIDTH };
}

function useKeyGrace(graceMs: number): () => boolean {
  const openedAt = useRef(Date.now());
  return useCallback(() => Date.now() - openedAt.current >= graceMs, [graceMs]);
}

/**
 * Whole seconds left of the answer window, counted from when the prompt
 * opened (the engine starts its timer then). Only the desktop and the web
 * count down; the terminal names the window once in its footer line.
 */
function useSecondsLeft(windowMs: number, live: boolean): number {
  const [openedAt] = useState(() => Date.now());
  const [now, setNow] = useState(openedAt);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live]);
  return Math.max(0, Math.ceil((windowMs - (now - openedAt)) / 1_000));
}

function useCloseOnAbort(signal: AbortSignal, close: () => void) {
  useEffect(() => {
    if (signal.aborted) {
      close();
      return;
    }
    signal.addEventListener("abort", close, { once: true });
    return () => signal.removeEventListener("abort", close);
  }, [close, signal]);
}

interface PromptProps {
  caller: RelayCaller;
  signal: AbortSignal;
  /** How long after opening keys are ignored; tests pass 0. */
  keyGraceMs?: number;
}

/** First time an assistant asks to drive this terminal. */
export function AssistantApprovalDialog({
  resolve,
  caller,
  signal,
  keyGraceMs = KEY_GRACE_MS,
}: PromptContext<AssistantDecision> & PromptProps) {
  const colors = useThemeColors();
  const size = usePromptWidth();
  const keysReady = useKeyGrace(keyGraceMs);
  const deny = useCallback(() => resolve("deny"), [resolve]);
  useCloseOnAbort(signal, deny);
  useDialogKeyboard((event) => {
    event.stopPropagation();
    event.preventDefault();
    if (event.name === "escape" || isPlainKey(event, "n", "d")) {
      deny();
      return;
    }
    if (!keysReady()) return;
    if (isPlainKey(event, "s")) resolve("session");
    else if (isPlainKey(event, "a")) resolve("always");
  }, { allowEditable: true });

  return (
    <RemoteUiScope scope={RELAY_PROMPT_SCOPE}>
      <DialogFrame
        title={tf("{name} wants to control this terminal", { name: caller.name })}
        footer={t("S this session · A always · N or Esc deny")}
        desktopFooter={null}
      >
        <Box flexDirection="column" {...size}>
          <Text fg={colors.text} wrapText>
            {t("It connected through Gloom Cloud with Terminal control. It can read what is on screen, open and arrange panes and switch layouts.")}
          </Text>
          <Box height={1} />
          <Text fg={colors.textDim} wrapText>
            {t("Orders, transfers, messages and plugin actions still ask you each time. Revoke it any time in Account Management, Agents.")}
          </Text>
          <Box height={1} />
          <DialogActions wrap>
            <Button label={t("Allow for this session")} variant="primary" desktopShortcut="s" onPress={() => resolve("session")} />
            <Button label={t("Always allow")} variant="secondary" desktopShortcut="a" onPress={() => resolve("always")} />
            <Button label={t("Deny")} variant="secondary" desktopShortcut="n" onPress={deny} />
          </DialogActions>
        </Box>
      </DialogFrame>
    </RemoteUiScope>
  );
}

/**
 * Every call that can reach an outside service. There is no "always" here,
 * and only `y` allows: `a` means "always" in the approval prompt.
 */
export function CallConfirmationDialog({
  resolve,
  caller,
  summary,
  signal,
  keyGraceMs = KEY_GRACE_MS,
}: PromptContext<ConfirmationAnswer> & PromptProps & { summary: CallSummary }) {
  const colors = useThemeColors();
  const size = usePromptWidth();
  const terminal = useUiHost().kind === "opentui";
  const secondsLeft = useSecondsLeft(CONFIRM_WINDOW_MS, !terminal);
  const keysReady = useKeyGrace(keyGraceMs);
  const deny = useCallback(() => resolve("deny"), [resolve]);
  useCloseOnAbort(signal, deny);
  useDialogKeyboard((event) => {
    event.stopPropagation();
    event.preventDefault();
    if (event.name === "escape" || isPlainKey(event, "n", "d")) {
      deny();
      return;
    }
    if (keysReady() && isPlainKey(event, "y")) resolve("allow");
  }, { allowEditable: true });
  const labelWidth = Math.max(0, ...summary.lines.map((line) => line.label.length)) + 2;

  return (
    <RemoteUiScope scope={RELAY_PROMPT_SCOPE}>
      <DialogFrame
        title={tf("{name} asks to run an action", { name: caller.name })}
        footer={tf("Y allow · N or Esc deny · denied after {seconds} s", { seconds: Math.round(CONFIRM_WINDOW_MS / 1_000) })}
        desktopFooter={null}
      >
        <Box flexDirection="column" {...size}>
          <Text fg={colors.textBright} wrapText>{summary.title}</Text>
          <Box height={1} />
          {summary.lines.map((line, index) => (
            <Box key={`${line.label}:${index}`} flexDirection="row">
              <Box width={labelWidth} flexShrink={0}>
                <Text fg={colors.textDim}>{line.label}</Text>
              </Box>
              <Text fg={colors.text} wrapText>{line.value}</Text>
            </Box>
          ))}
          <Box height={1} />
          <DialogActions wrap hints={{ note: tf("Denied in {seconds} s", { seconds: secondsLeft }) }}>
            <Button label={t("Allow")} variant="primary" desktopShortcut="y" onPress={() => resolve("allow")} />
            <Button label={t("Deny")} variant="secondary" desktopShortcut="n" onPress={deny} />
          </DialogActions>
        </Box>
      </DialogFrame>
    </RemoteUiScope>
  );
}

/** The engine's prompts, drawn with the app's dialog host. */
export function dialogRelayPrompts(dialog: DialogApi): RelayPrompts {
  return {
    async askApproval(caller, signal): Promise<ApprovalAnswer> {
      const answer = await dialog.prompt<AssistantDecision>({
        closeOnClickOutside: false,
        closeOnEscape: true,
        content: (context: PromptContext<AssistantDecision>) => <AssistantApprovalDialog {...context} caller={caller} signal={signal} />,
      }).catch(logFailure("cloud.terminal-relay.prompts", "The agent approval prompt failed"));
      return answer ?? "deny";
    },
    async askConfirmation(caller, summary, signal): Promise<ConfirmationAnswer> {
      const answer = await dialog.prompt<ConfirmationAnswer>({
        closeOnClickOutside: false,
        closeOnEscape: true,
        content: (context: PromptContext<ConfirmationAnswer>) => <CallConfirmationDialog {...context} caller={caller} summary={summary} signal={signal} />,
      }).catch(logFailure("cloud.terminal-relay.prompts", "The call confirmation prompt failed"));
      return answer ?? "deny";
    },
  };
}
