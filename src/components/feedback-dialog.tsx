/**
 * Send Feedback: a title, a message, an optional screenshot, Send. Opened
 * from the status bar, the `FB` command and Help. The report carries scrubbed
 * debug logs and app details so a bug can be traced without a back-and-forth.
 *
 * `FeedbackDialogHost` is mounted by the shell for the life of the app and
 * owns the dialog; `requestFeedbackDialog` lets commands and chrome open it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../api-client";
import { collectFeedbackDiagnostics, collectFeedbackLogs, feedbackSource } from "../feedback/diagnostics";
import { captureAppImageScreenshot, terminalFrameScreenshot } from "../feedback/screenshot";
import {
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_TITLE_MAX,
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
  type InputRenderable,
  type TextareaRenderable,
} from "../ui";
import { useDialog, useDialogKeyboard, type PromptContext } from "../ui/dialog";
import { useToastHost } from "../ui/toast";
import { VERSION } from "../version";
import { Button } from "./ui/button";
import { TextField } from "./ui/fields";
import { DialogFrame } from "./ui/frame";

type Field = "title" | "message";

/** What the person typed, kept when the dialog closes without sending. */
const draft = { title: "", message: "" };

const CONTENT_WIDTH = 64;
/** Border plus padding the terminal dialog host draws around the content. */
const TERMINAL_DIALOG_CHROME = 6;
const MESSAGE_ROWS = 6;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t("Couldn't send. Try again.");
}

export function FeedbackDialog({
  dialogId,
  resolve,
  dismiss,
  terminalScreenshot,
  buildReport,
  width,
}: PromptContext<FeedbackSubmitResponse | undefined> & {
  width: number;
  /** The screen as it was when the dialog opened, on the terminal renderer. */
  terminalScreenshot: FeedbackScreenshot | null;
  buildReport: (input: { title: string; message: string; screenshot: FeedbackScreenshot | null }) => FeedbackSubmitRequest;
}) {
  useAppLanguage();
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const titleRef = useRef<InputRenderable | null>(null);
  const messageRef = useRef<TextareaRenderable | null>(null);
  const [activeField, setActiveField] = useState<Field>("title");
  const [title, setTitle] = useState(draft.title);
  const messageValueRef = useRef(draft.message);
  const [screenshot, setScreenshot] = useState<FeedbackScreenshot | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = apiClient.isSignedIn();
  const canAttach = !!terminalScreenshot || nativePaneChrome;

  const focusActiveField = useCallback(() => {
    if (activeField === "title") titleRef.current?.focus?.();
    else messageRef.current?.focus?.();
  }, [activeField]);

  useEffect(focusActiveField, [focusActiveField]);

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
    if (sending || capturing) return;
    const message = readMessage().trim().slice(0, FEEDBACK_MESSAGE_MAX);
    const trimmedTitle = title.trim().slice(0, FEEDBACK_TITLE_MAX);
    if (!trimmedTitle && !message) {
      setError(t("Write a title or a message."));
      return;
    }
    setSending(true);
    setError(null);
    try {
      const response = await apiClient.submitFeedback(buildReport({ title: trimmedTitle, message, screenshot }));
      draft.title = "";
      draft.message = "";
      resolve(response);
    } catch (errorValue) {
      setError(errorMessage(errorValue));
      setSending(false);
    }
  }, [buildReport, capturing, resolve, screenshot, sending, title]);

  // A click on the button takes DOM focus; hand it back so Enter still sends.
  const toggleScreenshot = useCallback(async () => {
    if (screenshot || terminalScreenshot) {
      setScreenshot(screenshot ? null : terminalScreenshot);
      focusActiveField();
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
      focusActiveField();
    }
  }, [focusActiveField, screenshot, terminalScreenshot]);

  const signIn = () => {
    dismiss();
    requestAuthDialog({ onSignedIn: () => { requestFeedbackDialog(); } });
  };

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      event.stopPropagation?.();
      dismiss();
      return;
    }
    if (event.name === "tab") {
      event.preventDefault?.();
      event.stopPropagation?.();
      setActiveField((field) => (field === "title" ? "message" : "title"));
    }
  }, { scope: dialogId, allowEditable: true });

  // Button translates its own label.
  const sendLabel = sending ? "Sending..." : "Send";
  const screenshotLabel = capturing
    ? "Capturing..."
    : screenshot ? "Screenshot attached" : "Attach screenshot";

  return (
    <DialogFrame title="Send Feedback" footer="Enter send · Shift+Enter newline · Esc cancel">
      <Box flexDirection="column" width={width} gap={1}>
        <TextField
          inputRef={titleRef}
          value={title}
          placeholder={t("Short title")}
          focused={activeField === "title"}
          width={width}
          size="comfortable"
          {...(!nativePaneChrome ? { backgroundColor: colors.panel } : {})}
          onMouseDown={() => setActiveField("title")}
          onChange={(value) => {
            const next = value.slice(0, FEEDBACK_TITLE_MAX);
            setTitle(next);
            draft.title = next;
          }}
          onSubmit={() => setActiveField("message")}
        />
        <Box
          height={MESSAGE_ROWS}
          border
          borderColor={activeField === "message" ? colors.borderFocused : colors.border}
          backgroundColor={colors.panel}
          onMouseDown={() => setActiveField("message")}
          // Match the title field's corners on the DOM renderers.
          {...(nativePaneChrome ? { style: { borderRadius: 6, overflow: "hidden" } } : {})}
        >
          <Textarea
            ref={messageRef}
            initialValue={draft.message}
            placeholder={t("What happened, or what would you like to see?")}
            focused={activeField === "message"}
            textColor={colors.text}
            placeholderColor={colors.textDim}
            backgroundColor={colors.panel}
            flexGrow={1}
            wrapText
            {...(nativePaneChrome ? { style: { padding: "6px 8px", lineHeight: "18px" } } : {})}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "linefeed", action: "submit" },
              { name: "return", shift: true, action: "newline" },
              { name: "linefeed", shift: true, action: "newline" },
              // Terminals without the kitty keyboard protocol cannot report Shift+Enter.
              { name: "return", meta: true, action: "newline" },
              { name: "linefeed", meta: true, action: "newline" },
            ]}
            onSubmit={() => { void send(); }}
            onInput={(value: string) => {
              messageValueRef.current = value;
              draft.message = value;
            }}
          />
        </Box>
        {error ? <Text fg={colors.negative} wrapText width={width}>{error}</Text> : null}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Button label={sendLabel} variant="primary" disabled={sending || capturing} onPress={() => { void send(); }} />
          <Button label="Cancel" variant="secondary" disabled={sending} onPress={dismiss} />
          <Box flexGrow={1} />
          {canAttach && (
            <Button
              label={screenshotLabel}
              variant="plain"
              compact
              active={!!screenshot}
              disabled={capturing || sending}
              title={screenshot ? t("Remove screenshot") : undefined}
              onPress={() => { void toggleScreenshot(); }}
            />
          )}
        </Box>
        {!signedIn && (
          <Box flexDirection="row">
            <Button label="Sign in to get a reply" variant="plain" compact flush onPress={signIn} />
          </Box>
        )}
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
        const buildReport = ({ title, message, screenshot }: { title: string; message: string; screenshot: FeedbackScreenshot | null }): FeedbackSubmitRequest => ({
          title,
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
                width={width}
              />
            ),
          })
          .then((response) => {
            if (!response) return;
            for (const listener of feedbackSentListeners) listener();
            toast.success(response.replyTo
              ? tf("Thanks. We'll reply to {email}.", { email: response.replyTo })
              : t("Thanks. Your feedback was sent."));
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
