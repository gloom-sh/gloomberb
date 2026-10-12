import { useCallback, useMemo, useRef, useState } from "react";
import { Button, Notice, SelectButton, TextField, type SelectControl } from "../../../../components/ui";
import { DialogActions } from "../../../../components/ui/dialog-actions";
import { DialogFrame, fitDialogWidth } from "../../../../components/ui/frame";
import { t } from "../../../../i18n";
import { useAppLanguage } from "../../../../i18n/react";
import {
  paneImageThumbnail,
  personalDataQuestion,
  pngDataUrl,
  type PaneImageCapture,
} from "../../../../shares/pane-image";
import { useThemeColors } from "../../../../theme/theme-context";
import { Box, ImageSurface, Span, Text, TextAttributes, useUiCapabilities } from "../../../../ui";
import { useDialogKeyboard, type PromptContext } from "../../../../ui/dialog";
import { isPlainKey } from "../../../../utils/keyboard";
import { truncateWithEllipsis } from "../../../../utils/text-wrap";
import { chatImageLabel } from "../attachments/model";
import type { ShareTarget } from "./targets";

/** The widest the dialog gets, in cells; the preview is as wide as the form. */
export const SHARE_DIALOG_COLUMNS = 72;

type ShareField = "channel" | "caption" | "post";
const FIELDS: readonly ShareField[] = ["channel", "caption", "post"];

export interface SharePost {
  channelId: string;
  caption: string;
}

export interface ShareToChatDialogProps extends PromptContext<SharePost & { messageId: string }> {
  capture: PaneImageCapture;
  targets: readonly ShareTarget[];
  defaultChannelId: string;
  /** Terminal: the dialog's content width and the rows the preview may take. */
  width: number;
  previewRows: number;
  post: (request: SharePost) => Promise<{ messageId: string }>;
}

/** The terminal's stand-in for the picture where it cannot draw images: half blocks, two pixels a cell. */
function ThumbnailRows({ capture, cols, rows }: { capture: PaneImageCapture; cols: number; rows: number }) {
  const lines = useMemo(() => (
    capture.pixels ? paneImageThumbnail({ width: capture.width, height: capture.height, pixels: capture.pixels }, cols, rows) : []
  ), [capture, cols, rows]);
  return (
    <Box flexDirection="column" alignItems="center" width={cols}>
      {lines.map((line, row) => (
        <Text key={row}>
          {line.map((cell, col) => <Span key={col} fg={cell.top} bg={cell.bottom}>▀</Span>)}
        </Text>
      ))}
    </Box>
  );
}

/** The terminal's preview of a pane that fits: its own cells, as the picture draws them. */
function CellRows({ cells }: { cells: NonNullable<PaneImageCapture["cells"]> }) {
  const rows = useMemo(() => {
    const result: Array<Array<{ text: string; fg: string; bg: string; bold: boolean }>> = [];
    for (let row = 0; row < cells.rows; row += 1) {
      const spans: Array<{ text: string; fg: string; bg: string; bold: boolean }> = [];
      for (const cell of cells.cells.slice(row * cells.cols, (row + 1) * cells.cols)) {
        if (!cell.char) continue;
        const last = spans.at(-1);
        if (last && last.fg === cell.fg && last.bg === cell.bg && last.bold === cell.bold) last.text += cell.char;
        else spans.push({ text: cell.char, fg: cell.fg, bg: cell.bg, bold: cell.bold });
      }
      result.push(spans);
    }
    return result;
  }, [cells]);
  return (
    <Box flexDirection="column" width={cells.cols}>
      {rows.map((spans, row) => (
        <Text key={row}>
          {spans.map((span, index) => (
            <Span key={index} fg={span.fg} bg={span.bg} attributes={span.bold ? TextAttributes.BOLD : 0}>{span.text}</Span>
          ))}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Share to Chat: the pane's picture as it will be posted, where it goes and
 * an optional caption. A pane that shows the person's own data asks before
 * posting, under the preview, and Enter in the caption does not post it.
 */
export function ShareToChatDialog({
  dialogId,
  resolve,
  dismiss,
  capture,
  targets,
  defaultChannelId,
  width,
  previewRows,
  post,
}: ShareToChatDialogProps) {
  useAppLanguage();
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const [channelId, setChannelId] = useState(defaultChannelId);
  const [caption, setCaption] = useState("");
  const [activeField, setActiveField] = useState<ShareField>("caption");
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const channelControl = useRef<SelectControl | null>(null);
  const captionRef = useRef(caption);
  captionRef.current = caption;
  const previewUrl = useMemo(() => (nativePaneChrome ? pngDataUrl(capture.png) : ""), [capture.png, nativePaneChrome]);
  const question = capture.personalData ? personalDataQuestion(capture.personalData) : null;
  const meta = `${capture.title} · ${chatImageLabel({ width: capture.width, height: capture.height, size: capture.png.byteLength })}`;

  const submit = useCallback(async () => {
    if (postingRef.current) return;
    postingRef.current = true;
    setPosting(true);
    setError(null);
    const request = { channelId, caption: captionRef.current.trim() };
    try {
      const { messageId } = await post(request);
      resolve({ ...request, messageId });
    } catch (failure) {
      postingRef.current = false;
      setPosting(false);
      setError(failure instanceof Error && failure.message ? failure.message : t("Could not post. Try again."));
    }
  }, [channelId, post, resolve]);

  const move = useCallback((delta: 1 | -1) => {
    setActiveField((field) => FIELDS[(FIELDS.indexOf(field) + delta + FIELDS.length) % FIELDS.length]!);
  }, []);

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      event.stopPropagation?.();
      if (!postingRef.current) dismiss();
      return;
    }
    if (event.name === "tab" && !event.ctrl && !event.meta && !event.alt) {
      event.preventDefault?.();
      event.stopPropagation?.();
      move(event.shift ? -1 : 1);
      return;
    }
    if (activeField === "caption") return;
    if (isPlainKey(event, "down", "j", "up", "k")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      move(event.name === "up" || event.name === "k" ? -1 : 1);
      return;
    }
    if (event.name === "return" || event.name === "enter" || isPlainKey(event, "space")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (activeField === "channel") channelControl.current?.open();
      else void submit();
    }
  }, { scope: dialogId, allowEditable: true });

  const channelOptions = useMemo(() => targets.map((target) => ({
    value: target.channelId,
    label: target.label,
    ...(target.description ? { description: target.description } : {}),
  })), [targets]);

  const preview = nativePaneChrome ? (
    <ImageSurface
      src={previewUrl}
      alt={capture.title}
      objectFit="contain"
      style={{
        width: "100%",
        height: `min(46vh, calc(${fitDialogWidth(SHARE_DIALOG_COLUMNS)} * ${capture.height / Math.max(1, capture.width)}))`,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        backgroundColor: colors.bg,
      }}
    />
  ) : capture.cells && capture.cells.cols <= width && capture.cells.rows <= previewRows ? (
    // A pane that fits shows as its own cells. Kitty images stay out of the
    // terminal preview: a dialog covers them, its own included.
    <Box width={width} alignItems="center">
      <CellRows cells={capture.cells} />
    </Box>
  ) : (
    <Box width={width} alignItems="center">
      <ThumbnailRows capture={capture} cols={width} rows={previewRows} />
    </Box>
  );

  return (
    <DialogFrame title="Share to Chat" footer="Enter post · Tab next field · Esc cancel" desktopFooter={null}>
      <Box flexDirection="column" gap={1} {...(nativePaneChrome ? { style: { width: fitDialogWidth(SHARE_DIALOG_COLUMNS) } } : { width })}>
        <Box flexDirection="column">
          {preview}
          <Text fg={colors.textDim}>{truncateWithEllipsis(meta, width)}</Text>
        </Box>
        <SelectButton
          label={t("Channel")}
          title={t("Post to")}
          variant="field"
          value={channelId}
          options={channelOptions}
          disabled={posting}
          controlRef={channelControl}
          onFocus={() => setActiveField("channel")}
          onChange={(next) => {
            setChannelId(next);
            setError(null);
          }}
        />
        <TextField
          label={t("Caption")}
          active={activeField === "caption"}
          focused={activeField === "caption" && !posting}
          value={caption}
          placeholder={t("Optional")}
          width={width}
          onMouseDown={() => setActiveField("caption")}
          onChange={(value) => {
            setCaption(value);
            setError(null);
          }}
          onSubmit={() => {
            // Holdings and private messages are posted only with the button.
            if (question) setActiveField("post");
            else void submit();
          }}
        />
        {question ? <Notice tone="warning">{t(question)}</Notice> : null}
        {error ? <Text fg={colors.negative} wrapText>{error}</Text> : null}
        <DialogActions alignEnd>
          <Button label="Cancel" variant="secondary" disabled={posting} desktopShortcut="Esc" onPress={dismiss} />
          <Button
            label={posting ? t("Posting...") : t("Post")}
            variant={question ? "danger" : "primary"}
            active={!nativePaneChrome && activeField === "post"}
            disabled={posting}
            desktopShortcut={question ? undefined : "Enter"}
            onPress={() => { void submit(); }}
          />
        </DialogActions>
      </Box>
    </DialogFrame>
  );
}
