import { useCallback, useRef, useState } from "react";
import { Button, Notice, TextField } from "../components/ui";
import { DialogActions } from "../components/ui/dialog-actions";
import { DialogFrame, fitDialogWidth } from "../components/ui/frame";
import { t, tf } from "../i18n";
import { useAppLanguage } from "../i18n/react";
import { useThemeColors } from "../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../ui";
import { useDialogKeyboard, type PromptContext } from "../ui/dialog";
import { isPlainKey } from "../utils/keyboard";
import { BUG_REPORT_CHANNEL_ID, bugReportLine } from "./bug-report";
import { CAPTURE_DIALOG_COLUMNS, CapturePreview } from "./capture-preview";
import { personalDataQuestion, type PaneImageCapture } from "./pane-image";

type BugReportField = "text" | "send";

export interface BugReportSent {
  messageId: string;
}

export interface BugReportDialogProps extends PromptContext<BugReportSent> {
  capture: PaneImageCapture;
  /** The pane and the app as the report names them, under the picture. */
  context: string;
  /** Terminal: the dialog's content width and the rows the preview may take. */
  width: number;
  previewRows: number;
  /** What was typed before, kept when the dialog closed without sending. */
  initialText?: string;
  onTextChange?: (text: string) => void;
  send: (line: string) => Promise<BugReportSent>;
}

/**
 * Report a Bug: the pane's picture as it will be posted, the pane and the
 * app version, and one line saying what went wrong, all public in #bugs. A
 * pane that shows the person's own data asks before sending, as Share does,
 * and Enter in the line does not send it. A failed send keeps the form and
 * the line.
 */
export function BugReportDialog({
  dialogId,
  resolve,
  dismiss,
  capture,
  context,
  width,
  previewRows,
  initialText = "",
  onTextChange,
  send,
}: BugReportDialogProps) {
  useAppLanguage();
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const [text, setText] = useState(initialText);
  const textRef = useRef(text);
  textRef.current = text;
  const [activeField, setActiveField] = useState<BugReportField>("text");
  const [sending, setSending] = useState(false);
  // State lags a render behind: two presses in one terminal read would both see `sending` false.
  const sendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const question = capture.personalData ? personalDataQuestion(capture.personalData) : null;

  const submit = useCallback(async () => {
    if (sendingRef.current) return;
    const line = bugReportLine(textRef.current);
    if (!line) {
      setError(t("Say what went wrong."));
      setActiveField("text");
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      resolve(await send(line));
    } catch (failure) {
      sendingRef.current = false;
      setSending(false);
      setError(failure instanceof Error && failure.message ? failure.message : t("Couldn't send. Try again."));
    }
  }, [resolve, send]);

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      event.stopPropagation?.();
      if (!sendingRef.current) dismiss();
      return;
    }
    if (event.name === "tab" && !event.ctrl && !event.meta && !event.alt) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setActiveField((field) => (field === "text" ? "send" : "text"));
      return;
    }
    if (activeField === "text") return;
    if (isPlainKey(event, "down", "j", "up", "k")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setActiveField("text");
      return;
    }
    if (event.name === "return" || event.name === "enter" || isPlainKey(event, "space")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      void submit();
    }
  }, { scope: dialogId, allowEditable: true });

  return (
    <DialogFrame title="Report a Bug" footer="Enter send · Tab next field · Esc cancel" desktopFooter={null}>
      <Box flexDirection="column" gap={1} {...(nativePaneChrome ? { style: { width: fitDialogWidth(CAPTURE_DIALOG_COLUMNS) } } : { width })}>
        <CapturePreview capture={capture} meta={context} width={width} previewRows={previewRows} />
        <TextField
          label={t("What went wrong")}
          active={activeField === "text"}
          focused={activeField === "text" && !sending}
          value={text}
          placeholder={t("One line")}
          width={width}
          onMouseDown={() => setActiveField("text")}
          onChange={(value) => {
            setText(value);
            onTextChange?.(value);
            setError(null);
          }}
          onSubmit={() => {
            // Holdings and private messages are sent only with the button.
            if (question) setActiveField("send");
            else void submit();
          }}
        />
        <Notice tone="muted">{tf("Everyone in {channel} sees this line and picture.", { channel: `#${BUG_REPORT_CHANNEL_ID}` })}</Notice>
        {question ? <Notice tone="warning">{t(question)}</Notice> : null}
        {error ? <Text fg={colors.negative} wrapText>{error}</Text> : null}
        <DialogActions alignEnd>
          <Button label="Cancel" variant="secondary" disabled={sending} desktopShortcut="Esc" onPress={dismiss} />
          <Button
            label={sending ? t("Sending...") : t("Send")}
            variant={question ? "danger" : "primary"}
            active={!nativePaneChrome && activeField === "send"}
            disabled={sending}
            desktopShortcut={question ? undefined : "Enter"}
            onPress={() => { void submit(); }}
          />
        </DialogActions>
      </Box>
    </DialogFrame>
  );
}
