import { useCallback, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Notice, SelectButton, TextField, type SelectControl } from "../components/ui";
import { DialogActions } from "../components/ui/dialog-actions";
import { DialogFrame, fitDialogWidth } from "../components/ui/frame";
import { t } from "../i18n";
import { useAppLanguage } from "../i18n/react";
import { personalDataQuestion, type PaneImageCapture } from "./pane-image";
import { CAPTURE_DIALOG_COLUMNS, CapturePreview } from "./capture-preview";
import { useThemeColors } from "../theme/theme-context";
import { Box, Text, useUiCapabilities, useRendererHost } from "../ui";
import { useDialogKeyboard, type PromptContext } from "../ui/dialog";
import { isPlainKey } from "../utils/keyboard";
import { createOneShot } from "../utils/one-shot";

import type { SharePost, ShareTarget } from "./chat";

type ShareField = "destination" | "channel" | "caption" | "includeLink" | "post";

export type ShareResult = ({ kind: "post"; messageId: string } & SharePost) | { kind: "copy" };

export interface ShareDialogProps extends PromptContext<ShareResult> {
  capture: PaneImageCapture;
  targets: readonly ShareTarget[];
  defaultChannelId: string;
  chatAvailable?: boolean;
  /** Terminal: the dialog's content width and the rows the preview may take. */
  width: number;
  previewRows: number;
  post: (request: SharePost) => Promise<{ messageId: string }>;
  getLink: (() => Promise<string>) | null;
  defaultIncludeLink: boolean;
  onIncludeLinkChange: (value: boolean) => void;
}

/**
 * Share: the pane's picture as it will be posted, where it goes and
 * an optional caption. A pane that shows the person's own data asks before
 * posting, under the preview, and Enter in the caption does not post it.
 */
export function ShareDialog({
  dialogId,
  resolve,
  dismiss,
  capture,
  targets,
  defaultChannelId,
  chatAvailable = true,
  width,
  previewRows,
  post,
  getLink,
  defaultIncludeLink,
  onIncludeLinkChange,
}: ShareDialogProps) {
  useAppLanguage();
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const rendererHost = useRendererHost();
  const [destination, setDestination] = useState(chatAvailable ? "chat" : "link");
  const [includeLink, setIncludeLink] = useState(defaultIncludeLink);
  const destinationControl = useRef<SelectControl | null>(null);
  const fields: readonly ShareField[] = destination === "chat"
    ? ["destination", "channel", "caption", ...(getLink ? ["includeLink" as const] : []), "post"]
    : ["destination", "post"];
  const [channelId, setChannelId] = useState(defaultChannelId);
  const [caption, setCaption] = useState("");
  const [activeField, setActiveField] = useState<ShareField>(chatAvailable ? "caption" : "post");
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const channelControl = useRef<SelectControl | null>(null);
  const captionRef = useRef(caption);
  captionRef.current = caption;
  // The Enter that moved to Post, held or pressed twice, must not press it:
  // Post by key waits until the key has been up a moment.
  const [postKey] = useState(createOneShot);
  const question = capture.personalData ? personalDataQuestion(capture.personalData) : null;
  const meta = `${capture.title} · ${capture.width}x${capture.height} · ${Math.ceil(capture.png.byteLength / 1024)} KB`;

  const submit = useCallback(async () => {
    if (postingRef.current) return;
    postingRef.current = true;
    setPosting(true);
    setError(null);
    const request = { channelId, caption: captionRef.current.trim(), includeLink };
    try {
      if (destination === "link") {
        if (!getLink) throw new Error(t("A public link is unavailable for this pane."));
        await rendererHost.copyText(await getLink());
        resolve({ kind: "copy" });
      } else {
        const { messageId } = await post(request);
        resolve({ ...request, kind: "post", messageId });
      }
    } catch (failure) {
      postingRef.current = false;
      setPosting(false);
      setError(failure instanceof Error && failure.message ? failure.message : t("Could not share. Try again."));
    }
  }, [channelId, destination, getLink, includeLink, post, rendererHost, resolve]);

  const toggleIncludeLink = (value: boolean) => {
    setIncludeLink(value);
    setActiveField("includeLink");
    onIncludeLinkChange(value);
  };

  const move = useCallback((delta: 1 | -1) => {
    setActiveField((field) => fields[(fields.indexOf(field) + delta + fields.length) % fields.length]!);
  }, [fields]);

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
      if (activeField === "destination") destinationControl.current?.open();
      else if (activeField === "channel") channelControl.current?.open();
      else if (activeField === "includeLink") toggleIncludeLink(!includeLink);
      else if (!postKey.refuses({ repeat: event.repeat })) void submit();
    }
  }, { scope: dialogId, allowEditable: true });

  const channelOptions = useMemo(() => targets.map((target) => ({
    value: target.channelId,
    label: target.label,
    ...(target.description ? { description: target.description } : {}),
  })), [targets]);

  return (
    <DialogFrame title="Share" footer="Enter select · Tab next field · Esc cancel" desktopFooter={null}>
      <Box flexDirection="column" gap={1} {...(nativePaneChrome ? { style: { width: fitDialogWidth(CAPTURE_DIALOG_COLUMNS) } } : { width })}>
        <CapturePreview capture={capture} meta={meta} width={width} previewRows={previewRows} />
        <SelectButton
          label={t("Destination")}
          title={t("Destination")}
          variant="field"
          value={destination}
          options={[
            { value: "chat", label: t("Post to chat"), disabled: !chatAvailable },
            { value: "link", label: t("Copy link"), disabled: !getLink },
          ]}
          disabled={posting}
          controlRef={destinationControl}
          onFocus={() => setActiveField("destination")}
          onChange={(next) => { setDestination(next); setActiveField("destination"); setError(null); }}
        />
        {destination === "chat" ? (<>
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
              if (!question) {
                void submit();
                return;
              }
              postKey.end();
              setActiveField("post");
            }}
          />
          {getLink ? <Checkbox label={t("Include link")} checked={includeLink} disabled={posting}
            active={activeField === "includeLink"} onChange={toggleIncludeLink} /> : null}
          {question ? <Notice tone="warning">{t(question)}</Notice> : null}
        </>) : null}
        {error ? <Text fg={colors.negative} wrapText>{error}</Text> : null}
        <DialogActions alignEnd>
          <Button label="Cancel" variant="secondary" disabled={posting} desktopShortcut="Esc" onPress={dismiss} />
          <Button
            label={posting ? (destination === "chat" ? t("Posting...") : t("Copying...")) : (destination === "chat" ? t("Post") : t("Copy link"))}
            variant={question && destination === "chat" ? "danger" : "primary"}
            active={!nativePaneChrome && activeField === "post"}
            disabled={posting}
            desktopShortcut={question && destination === "chat" ? undefined : "Enter"}
            onPress={() => { void submit(); }}
          />
        </DialogActions>
      </Box>
    </DialogFrame>
  );
}
