/**
 * Send Feedback: a message, an optional screenshot, Send. Opened
 * from the status bar, the `FB` command and Help. The report carries scrubbed
 * debug logs and app details so a bug can be traced without a back-and-forth.
 *
 * `FeedbackDialogHost` is mounted by the shell for the life of the app and
 * owns the dialog; `requestFeedbackDialog` lets commands and chrome open it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../api-client";
import { matchesKeybindingAction, useKeybindings, type KeyChordEventLike } from "../app/keybindings";
import { collectFeedbackDiagnostics, collectFeedbackLogs, feedbackSource } from "../feedback/diagnostics";
import { captureAppImageScreenshot, terminalFrameScreenshot } from "../feedback/screenshot";
import {
  FEEDBACK_MESSAGE_MAX,
  type FeedbackScreenshot,
  type FeedbackSubmitRequest,
  type FeedbackSubmitResponse,
} from "../feedback/types";
import { t, tf } from "../i18n";
import { useAppLanguage } from "../i18n/react";
import { requestAuthDialog } from "../plugins/builtin/cloud/auth-dialog";
import { getSharedRegistry } from "../plugins/registry";
import { useViewport } from "../react/input";
import { useAppStateRef } from "../state/app/context";
import { useThemeColors } from "../theme/theme-context";
import {
  Box,
  Text,
  Textarea,
  useNativeRenderer,
  useUiCapabilities,
  type TextareaRenderable,
} from "../ui";
import { useDialog, useDialogKeyboard, type PromptContext } from "../ui/dialog";
import { useToastHost } from "../ui/toast";
import { VERSION } from "../version";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { DialogFrame } from "./ui/frame";

/** What the person typed, kept when the dialog closes without sending. */
const draft = { message: "" };

const CONTENT_WIDTH = 64;
/** Border plus padding the terminal dialog host draws around the content. */
const TERMINAL_DIALOG_CHROME = 6;
const MESSAGE_ROWS = 6;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t("Couldn't send. Try again.");
}

type KeyLike = KeyChordEventLike & { preventDefault?: () => void };

/**
 * Enter starts a new line; Shift+Enter sends. Terminals without the kitty
 * keyboard protocol report Shift+Enter as Enter, so Alt+Enter also sends there.
 */
const TERMINAL_MESSAGE_KEYS = [
  { name: "return", action: "newline" },
  { name: "linefeed", action: "newline" },
  { name: "return", shift: true, action: "submit" },
  { name: "linefeed", shift: true, action: "submit" },
  { name: "return", meta: true, action: "submit" },
  { name: "linefeed", meta: true, action: "submit" },
];

export function FeedbackDialog({
  dialogId,
  resolve,
  dismiss,
  terminalScreenshot,
  buildReport,
  onSentAfterClose,
  width,
}: PromptContext<FeedbackSubmitResponse | undefined> & {
  width: number;
  /** The screen as it was when the dialog opened, on the terminal renderer. */
  terminalScreenshot: FeedbackScreenshot | null;
  buildReport: (input: { message: string; screenshot: FeedbackScreenshot | null }) => FeedbackSubmitRequest;
  /** A send that finishes after Esc still counts: the host announces it instead of resolving. */
  onSentAfterClose: (response: FeedbackSubmitResponse) => void;
}) {
  useAppLanguage();
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const keybindings = useKeybindings();
  const messageRef = useRef<TextareaRenderable | null>(null);
  const messageValueRef = useRef(draft.message);
  const [screenshot, setScreenshot] = useState<FeedbackScreenshot | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [sending, setSending] = useState(false);
  // State lags a render behind: two sends in one terminal read would both see `sending` false.
  const sendingRef = useRef(false);
  const closedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = apiClient.isSignedIn();
  const canAttach = !!terminalScreenshot || nativePaneChrome;

  const focusMessage = useCallback(() => {
    messageRef.current?.focus?.();
  }, []);

  useEffect(focusMessage, [focusMessage]);
  useEffect(() => () => {
    closedRef.current = true;
  }, []);

  const readMessage = () => {
    try {
      return messageRef.current?.editBuffer.getText() ?? messageValueRef.current;
    } catch {
      return messageValueRef.current;
    }
  };

  // The terminal textarea reports edits through `onContentChange`, not
  // `onInput` (see markdown-editor); keep the draft current either way.
  useEffect(() => {
    const textarea = messageRef.current;
    if (!textarea) return;
    textarea.onContentChange = () => {
      const value = readMessage();
      messageValueRef.current = value;
      draft.message = value;
    };
    return () => {
      textarea.onContentChange = undefined;
    };
  }, []);

  const send = useCallback(async () => {
    if (sendingRef.current || capturing) return;
    const message = readMessage().trim().slice(0, FEEDBACK_MESSAGE_MAX);
    if (!message) {
      setError(t("Write a message."));
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const response = await apiClient.submitFeedback(buildReport({ message, screenshot }));
      // Leave a draft alone if it has moved on since (typed into a reopened dialog).
      if (draft.message.trim() === message) draft.message = "";
      if (closedRef.current) onSentAfterClose(response);
      else resolve(response);
    } catch (errorValue) {
      sendingRef.current = false;
      if (closedRef.current) return;
      setError(errorMessage(errorValue));
      setSending(false);
    }
  }, [buildReport, capturing, onSentAfterClose, resolve, screenshot]);

  // A click on the checkbox takes DOM focus; hand it back so typing continues.
  const setScreenshotAttached = useCallback(async (attach: boolean) => {
    if (!attach || terminalScreenshot) {
      setScreenshot(attach ? terminalScreenshot : null);
      focusMessage();
      return;
    }
    setCapturing(true);
    setError(null);
    try {
      setScreenshot(await captureAppImageScreenshot());
    } catch (errorValue) {
      setError(errorValue instanceof Error && errorValue.message ? errorValue.message : t("Couldn't take a screenshot."));
    } finally {
      setCapturing(false);
      focusMessage();
    }
  }, [focusMessage, terminalScreenshot]);

  const signIn = () => {
    dismiss();
    // After the close settles: closing hands focus back to the pane behind,
    // which would otherwise land after the auth dialog focused its email field.
    setTimeout(() => {
      requestAuthDialog({ onSignedIn: () => { requestFeedbackDialog(); } });
    }, 0);
  };

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      event.stopPropagation?.();
      dismiss();
      return;
    }
    // The app's form submit key, for terminals that send neither Shift+Enter nor Alt+Enter.
    if (event.ctrl && event.name === "s") {
      event.preventDefault?.();
      event.stopPropagation?.();
      void send();
    }
  }, { scope: dialogId, allowEditable: true });

  // The DOM textarea submits on plain Enter whenever it has `onSubmit`, so on
  // desktop and web it gets none and Shift+Enter (or Alt/Cmd+Enter) sends here.
  const sendOnModifiedEnter = (event: KeyLike) => {
    if (event.name !== "return" || !(event.shift || event.alt || event.meta)) return;
    // Ctrl/Cmd+Shift+Enter and Alt+Enter act on the newest toast; that key
    // must not also send a half-written report.
    if (matchesKeybindingAction(keybindings, "notification-action", event)) return;
    event.preventDefault?.();
    void send();
  };

  return (
    <DialogFrame title="Send Feedback">
      <Box flexDirection="column" width={width} gap={1}>
        <Box
          height={MESSAGE_ROWS}
          border
          borderColor={colors.borderFocused}
          backgroundColor={colors.panel}
          onMouseDown={focusMessage}
          {...(nativePaneChrome ? { style: { borderRadius: 6, overflow: "hidden" } } : {})}
        >
          <Textarea
            ref={messageRef}
            initialValue={draft.message}
            placeholder={t("What happened, or what would you like to see?")}
            focused
            textColor={colors.text}
            placeholderColor={colors.textDim}
            backgroundColor={colors.panel}
            flexGrow={1}
            wrapText
            {...(nativePaneChrome
              ? { style: { padding: "6px 8px", lineHeight: "18px" }, onKeyDown: sendOnModifiedEnter }
              : { keyBindings: TERMINAL_MESSAGE_KEYS, onSubmit: () => { void send(); } })}
            onInput={(value: string) => {
              messageValueRef.current = value;
              draft.message = value;
            }}
          />
        </Box>
        {canAttach && (
          <Checkbox
            label={t("Attach screenshot")}
            flush
            checked={!!screenshot || capturing}
            disabled={capturing || sending}
            onChange={(checked) => { void setScreenshotAttached(checked); }}
          />
        )}
        {error ? <Text fg={colors.negative} wrapText width={width}>{error}</Text> : null}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Button label={sending ? "Sending..." : "Send"} variant="primary" disabled={sending || capturing} onPress={() => { void send(); }} />
          <Button label="Cancel" variant="secondary" disabled={sending} onPress={dismiss} />
          <Box flexGrow={1} />
          {!signedIn && (
            <Button label="Sign in to get a reply" variant="plain" compact disabled={sending} onPress={signIn} />
          )}
        </Box>
      </Box>
    </DialogFrame>
  );
}

const feedbackDialogListeners = new Set<() => void>();
const feedbackSentListeners = new Set<() => void>();

/** Called after a report is accepted, so lists of the person's reports can refresh. */
export function subscribeFeedbackSent(listener: () => void): () => void {
  feedbackSentListeners.add(listener);
  return () => {
    feedbackSentListeners.delete(listener);
  };
}

/** Returns false when no dialog host is mounted. */
export function requestFeedbackDialog(): boolean {
  if (feedbackDialogListeners.size === 0) return false;
  for (const listener of feedbackDialogListeners) listener();
  return true;
}

export function FeedbackDialogHost() {
  const dialog = useDialog();
  const nativeRenderer = useNativeRenderer();
  const stateRef = useAppStateRef();
  const viewport = useViewport();
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const toast = useToastHost();
  const openRef = useRef(false);

  useEffect(() => {
    const announce = (response: FeedbackSubmitResponse) => {
      for (const listener of feedbackSentListeners) listener();
      toast.success(response.replyTo
        ? tf("Thanks. We'll reply to {email}.", { email: response.replyTo })
        : t("Thanks. Your feedback was sent."));
    };
    const open = () => {
      if (openRef.current) return;
      openRef.current = true;
      // The command bar that ran `FB` is still on screen this tick; take the
      // terminal frame once it has closed, before the dialog draws over it.
      setTimeout(() => {
        let terminalScreenshot: FeedbackScreenshot | null = null;
        try {
          const frame = nativeRenderer.captureFrame?.();
          if (frame) terminalScreenshot = terminalFrameScreenshot(frame);
        } catch {
          terminalScreenshot = null;
        }
        const buildReport = ({ message, screenshot }: { message: string; screenshot: FeedbackScreenshot | null }): FeedbackSubmitRequest => ({
          // No title field: the cloud names the report from its first line.
          title: "",
          message,
          source: feedbackSource(),
          appVersion: VERSION,
          diagnostics: collectFeedbackDiagnostics(stateRef.current, getSharedRegistry() ?? null, viewportRef.current),
          logs: collectFeedbackLogs(),
          ...(screenshot ? { screenshot } : {}),
        });
        const width = Math.max(30, Math.min(CONTENT_WIDTH, viewportRef.current.width - TERMINAL_DIALOG_CHROME - 4));
        void dialog
          .prompt<FeedbackSubmitResponse | undefined>({
            closeOnClickOutside: false,
            // The terminal host defaults to 60 columns; the web host sizes to the content.
            style: { width: width + TERMINAL_DIALOG_CHROME },
            content: (context: unknown) => (
              <FeedbackDialog
                {...(context as PromptContext<FeedbackSubmitResponse | undefined>)}
                terminalScreenshot={terminalScreenshot}
                buildReport={buildReport}
                onSentAfterClose={announce}
                width={width}
              />
            ),
          })
          .then((response) => {
            if (response) announce(response);
          })
          .finally(() => {
            openRef.current = false;
          });
      }, 50);
    };
    feedbackDialogListeners.add(open);
    return () => {
      feedbackDialogListeners.delete(open);
    };
  }, [dialog, nativeRenderer, stateRef, toast]);

  return null;
}
