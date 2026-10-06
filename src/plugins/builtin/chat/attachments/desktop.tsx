import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text } from "../../../../ui";
import { Button, IconButton } from "../../../../components/ui";
import { useDialogKeyboard, useOptionalDialog, type AlertContext, type DialogApi } from "../../../../ui/dialog";
import { useRendererHost } from "../../../../ui";
import { blendHex } from "../../../../theme/colors";
import { useThemeColors } from "../../../../theme/theme-context";
import { t, tf } from "../../../../i18n";
import type { ChatAttachment } from "../../../../api-client";
import type { ChatDraftAttachment } from "../controller/attachments";
import {
  CHAT_IMAGE_TYPES,
  chatImageReviewNote,
  fitChatImage,
  formatChatImageSize,
  type ChatImageReviewNote,
} from "./model";
import {
  clipboardAttachments,
  transferCarriesFiles,
  transferFiles,
  type TransferData,
  type TransferFile,
} from "./transfer";

/**
 * Desktop and web only: the chat's image surfaces are real DOM (an <img>, a
 * file input, drag and drop), which the terminal draws as text rows instead.
 */

interface DomEventLike {
  preventDefault(): void;
  stopPropagation(): void;
}

interface DomDragEvent extends DomEventLike {
  dataTransfer: (TransferData & { dropEffect?: string }) | null;
}

interface DomClipboardEvent extends DomEventLike {
  clipboardData: TransferData | null;
  target: { closest?: (selector: string) => unknown } | null;
}

interface FileInputLike {
  click(): void;
  value: string;
  files: ArrayLike<TransferFile> | null;
}

/** Single images fit this box; several share a row at the smaller one. */
const SINGLE_IMAGE_BOX = { width: 320, height: 240 };
const GRID_IMAGE_BOX = { width: 156, height: 120 };
const IMAGE_GAP_PX = 4;
const CHIP_THUMB_PX = 40;

/**
 * Takes files dropped on the chat or pasted into its composer. It draws no box
 * of its own (`display: contents`), so the layout is the thread's; events
 * still bubble through it. `onDragActiveChange` lets the thread show where to
 * drop.
 */
export function DesktopChatDropTarget({
  enabled,
  onFiles,
  onDragActiveChange,
  children,
}: {
  enabled: boolean;
  onFiles: (files: TransferFile[]) => void;
  onDragActiveChange: (active: boolean) => void;
  children: ReactNode;
}) {
  const depthRef = useRef(0);
  const setActive = (active: boolean) => {
    if (!active) depthRef.current = 0;
    onDragActiveChange(active);
  };
  useEffect(() => {
    if (!enabled) setActive(false);
  }, [enabled]);

  const carriesFiles = (event: DomDragEvent) => enabled && transferCarriesFiles(event.dataTransfer);
  return createElement("div", {
    "data-gloom-role": "chat-drop-target",
    style: { display: "contents" },
    onDragEnter: (event: DomDragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depthRef.current += 1;
      setActive(true);
    },
    onDragOver: (event: DomDragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the drop opens the file in place of the app.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DomDragEvent) => {
      if (!carriesFiles(event)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setActive(false);
    },
    onDrop: (event: DomDragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setActive(false);
      const files = transferFiles(event.dataTransfer);
      if (files.length > 0) onFiles(files);
    },
    onPaste: (event: DomClipboardEvent) => {
      // Only the message field: a paste into another field over the thread (New DM) stays its own.
      if (!enabled || !event.target?.closest?.('[data-gloom-role="desktop-message-composer"]')) return;
      const files = clipboardAttachments(event.clipboardData);
      if (!files) return;
      event.preventDefault();
      onFiles(files);
    },
  }, children);
}

/** Shown over the thread while files are dragged across it. */
export function DesktopChatDropOverlay() {
  const colors = useThemeColors();
  return (
    <Box
      position="absolute"
      data-gloom-role="chat-drop-overlay"
      alignItems="center"
      justifyContent="center"
      style={{
        inset: 6,
        zIndex: 20,
        borderRadius: 8,
        border: `2px dashed ${colors.borderFocused}`,
        background: `color-mix(in srgb, ${colors.bg} 82%, transparent)`,
        pointerEvents: "none",
      }}
    >
      <Text fg={colors.textBright}>{t("Drop images to attach")}</Text>
    </Box>
  );
}

/**
 * The composer's attach button and the file picker behind it. `pickerRef`
 * lets the pane menu open the same picker from the keyboard.
 */
export function DesktopChatAttachButton({
  onFiles,
  pickerRef,
}: {
  onFiles: (files: TransferFile[]) => void;
  pickerRef: { current: (() => void) | null };
}) {
  const inputRef = useRef<FileInputLike | null>(null);
  useEffect(() => {
    pickerRef.current = () => inputRef.current?.click();
    return () => {
      pickerRef.current = null;
    };
  }, [pickerRef]);
  return (
    <>
      <IconButton
        icon="image"
        label="Attach Image"
        size={14}
        onPress={() => inputRef.current?.click()}
      />
      {createElement("input", {
        ref: (node: FileInputLike | null) => {
          inputRef.current = node;
        },
        type: "file",
        accept: CHAT_IMAGE_TYPES.join(","),
        multiple: true,
        tabIndex: -1,
        "aria-hidden": true,
        "data-gloom-role": "chat-attach-input",
        style: { display: "none" },
        onChange: (event: { currentTarget: FileInputLike }) => {
          const input = event.currentTarget;
          const files = Array.from(input.files ?? []);
          // Cleared so picking the same file again still fires a change.
          input.value = "";
          if (files.length > 0) onFiles(files);
        },
      })}
    </>
  );
}

/** The share sent while the bytes go out; null once they are all out and the server is at work, or when unknown. */
function uploadFraction(attachment: ChatDraftAttachment): number | null {
  return attachment.progress === null || attachment.progress >= 1 ? null : attachment.progress;
}

function chipStatus(attachment: ChatDraftAttachment): string {
  if (attachment.status === "failed") return attachment.error ?? t("Upload failed");
  if (attachment.status === "uploading") {
    const fraction = uploadFraction(attachment);
    return fraction === null
      ? t("Uploading...")
      : tf("Uploading {percent}%", { percent: Math.round(fraction * 100) });
  }
  return formatChatImageSize(attachment.uploaded?.size ?? attachment.size);
}

function DraftAttachmentChip({
  attachment,
  onRemove,
  onRetry,
}: {
  attachment: ChatDraftAttachment;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  const colors = useThemeColors();
  const failed = attachment.status === "failed";
  const uploading = attachment.status === "uploading";
  const status = chipStatus(attachment);
  const fraction = uploadFraction(attachment);
  const border = failed ? colors.negative : blendHex(colors.border, colors.text, 0.12);
  return (
    <Box
      flexDirection="row"
      data-gloom-role="chat-draft-attachment"
      data-status={attachment.status}
      title={`${attachment.name} ${formatChatImageSize(attachment.size)}`}
      style={{
        alignItems: "center",
        gap: 8,
        padding: "4px 4px 4px 4px",
        borderRadius: 6,
        border: `1px solid ${border}`,
        background: blendHex(colors.panel, colors.bg, 0.3),
        maxWidth: 260,
        minWidth: 0,
      }}
    >
      <Box
        style={{
          position: "relative",
          flex: "none",
          width: CHIP_THUMB_PX,
          height: CHIP_THUMB_PX,
          borderRadius: 4,
          overflow: "hidden",
          background: colors.bg,
        }}
      >
        {attachment.previewUrl && createElement("img", {
          src: attachment.previewUrl,
          alt: attachment.name,
          draggable: false,
          style: {
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
            opacity: uploading ? 0.55 : 1,
          },
        })}
        {uploading && (
          <Box
            data-gloom-role="chat-upload-progress"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 3,
              background: blendHex(colors.bg, colors.border, 0.5),
            }}
          >
            <Box
              className={fraction === null ? "gloom-chat-upload-indeterminate" : undefined}
              style={{
                height: "100%",
                width: fraction === null ? "40%" : `${Math.max(4, fraction * 100)}%`,
                background: colors.borderFocused,
                transition: "width 160ms ease-out",
              }}
            />
          </Box>
        )}
      </Box>
      <Box style={{ flex: "1 1 auto", minWidth: 0 }}>
        <Text
          fg={colors.text}
          style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {attachment.name}
        </Text>
        <Text
          fg={failed ? colors.negative : colors.textMuted}
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            whiteSpace: "normal",
            fontSize: "0.92em",
          }}
        >
          {status}
        </Text>
      </Box>
      {failed && (
        <Button
          label={t("Retry")}
          compact
          stopPropagation
          onPress={() => onRetry(attachment.localId)}
        />
      )}
      <IconButton
        icon="close"
        label={tf("Remove {name}", { name: attachment.name })}
        onPress={() => onRemove(attachment.localId)}
      />
    </Box>
  );
}

/** The images waiting in the composer, above the field. */
export function DesktopChatAttachmentStrip({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: ChatDraftAttachment[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <Box
      flexDirection="row"
      flexWrap="wrap"
      data-gloom-role="chat-draft-attachments"
      style={{ gap: 6, padding: "6px 10px 2px 10px", flex: "none" }}
    >
      {attachments.map((attachment) => (
        <DraftAttachmentChip
          key={attachment.localId}
          attachment={attachment}
          onRemove={onRemove}
          onRetry={onRetry}
        />
      ))}
    </Box>
  );
}

function imageAlt(index: number, count: number, caption: string, author: string): string {
  const text = caption.replace(/\s+/g, " ").trim();
  const position = count > 1 ? ` ${index + 1} of ${count}` : "";
  if (text) return `Image${position}: ${text.length > 120 ? `${text.slice(0, 117)}...` : text}`;
  return `Image${position} from @${author}`;
}

function MessageImage({
  attachment,
  box,
  alt,
  dimmed,
  onOpen,
  onLoadError,
}: {
  attachment: ChatAttachment;
  box: { width: number; height: number };
  alt: string;
  dimmed: boolean;
  onOpen: () => void;
  onLoadError?: (attachment: ChatAttachment) => void;
}) {
  const colors = useThemeColors();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const size = fitChatImage(attachment.width, attachment.height, box.width, box.height);
  const failed = failedUrl === attachment.url;
  const frame = {
    width: size.width,
    height: size.height,
    flex: "none",
    borderRadius: 6,
    overflow: "hidden",
    border: `1px solid ${blendHex(colors.border, colors.bg, 0.35)}`,
    background: blendHex(colors.panel, colors.bg, 0.5),
    opacity: dimmed ? 0.6 : 1,
  };
  if (failed) {
    return (
      <Box
        data-gloom-role="chat-message-image-unavailable"
        alignItems="center"
        justifyContent="center"
        title={alt}
        style={frame}
      >
        <Text fg={colors.textMuted} style={{ fontSize: "0.92em" }}>{t("Image unavailable")}</Text>
      </Box>
    );
  }
  return createElement("button", {
    type: "button",
    "data-gloom-role": "chat-message-image",
    "aria-label": tf("Open {alt}", { alt }),
    title: alt,
    style: {
      ...frame,
      padding: 0,
      margin: 0,
      cursor: "zoom-in",
      display: "block",
      font: "inherit",
      color: "inherit",
    },
    // A press on the image is not a press on the row behind it.
    onMouseDown: (event: DomEventLike) => event.stopPropagation(),
    onClick: (event: DomEventLike) => {
      event.stopPropagation();
      onOpen();
    },
  }, createElement("img", {
    src: attachment.url,
    alt,
    width: size.width,
    height: size.height,
    loading: "lazy",
    decoding: "async",
    draggable: false,
    style: { width: "100%", height: "100%", objectFit: "contain", display: "block" },
    onError: () => {
      setFailedUrl(attachment.url);
      onLoadError?.(attachment);
    },
  }));
}

function ReviewNote({ note }: { note: ChatImageReviewNote }) {
  const colors = useThemeColors();
  return (
    <Text
      fg={note.tone === "warning" ? colors.warning : colors.textMuted}
      data-gloom-role="chat-message-image-review"
      style={{ fontSize: "0.92em" }}
    >
      {t(note.text)}
    </Text>
  );
}

/**
 * A message's images, each in a box sized from its stored dimensions so the
 * transcript does not move as they load. A click opens the viewer.
 */
export function DesktopChatMessageImages({
  attachments,
  caption,
  author,
  review,
  dimmed,
  onLoadError,
}: {
  attachments: ChatAttachment[];
  caption: string;
  author: string;
  review: Parameters<typeof chatImageReviewNote>[0]["attachmentReview"];
  dimmed: boolean;
  onLoadError?: (attachment: ChatAttachment) => void;
}) {
  const dialog = useOptionalDialog();
  const rendererHost = useRendererHost();
  const note = chatImageReviewNote({ attachmentReview: review });
  if (attachments.length === 0 && !note) return null;
  const box = attachments.length === 1 ? SINGLE_IMAGE_BOX : GRID_IMAGE_BOX;
  const open = (index: number) => {
    if (dialog) {
      openChatImageViewer(dialog, { attachments, index, caption, author });
      return;
    }
    const attachment = attachments[index];
    if (attachment) void rendererHost.openExternal(attachment.url);
  };
  return (
    <Box data-gloom-role="chat-message-images" style={{ gap: 4, paddingTop: 2, paddingBottom: 2, minWidth: 0 }}>
      {attachments.length > 0 && (
        <Box
          flexDirection="row"
          flexWrap="wrap"
          style={{ gap: IMAGE_GAP_PX, alignItems: "flex-end", maxWidth: box.width * 2 + IMAGE_GAP_PX }}
        >
          {attachments.map((attachment, index) => (
            <MessageImage
              key={attachment.id}
              attachment={attachment}
              box={box}
              alt={imageAlt(index, attachments.length, caption, author)}
              dimmed={dimmed}
              onOpen={() => open(index)}
              onLoadError={onLoadError}
            />
          ))}
        </Box>
      )}
      {note && <ReviewNote note={note} />}
    </Box>
  );
}

/** Opens a message's images full size, at `index`. */
export function openChatImageViewer(
  dialog: DialogApi,
  options: { attachments: ChatAttachment[]; index: number; caption: string; author: string },
): void {
  void dialog.alert({
    closeOnClickOutside: true,
    content: (context: AlertContext) => (
      <ChatImageLightbox
        attachments={options.attachments}
        initialIndex={options.index}
        caption={options.caption}
        author={options.author}
        dismiss={context.dismiss}
      />
    ),
  });
}

/**
 * The full-size view of one message's images. Esc or a click outside closes
 * it (the dialog host's), Left and Right step through the message's images.
 */
function ChatImageLightbox({
  attachments,
  initialIndex,
  caption,
  author,
  dismiss,
}: {
  attachments: ChatAttachment[];
  initialIndex: number;
  caption: string;
  author: string;
  dismiss: () => void;
}) {
  const colors = useThemeColors();
  const rendererHost = useRendererHost();
  const [index, setIndex] = useState(() => Math.max(0, Math.min(initialIndex, attachments.length - 1)));
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const count = attachments.length;
  const attachment = attachments[index];
  const step = (direction: 1 | -1) => {
    if (count < 2) return;
    setIndex((current) => (current + direction + count) % count);
  };
  useDialogKeyboard((event) => {
    if (event.name === "left" || event.name === "right") {
      event.preventDefault?.();
      event.stopPropagation?.();
      step(event.name === "left" ? -1 : 1);
    }
  });
  if (!attachment) return null;
  const alt = imageAlt(index, count, caption, author);
  const failed = failedUrl === attachment.url;
  return (
    <Box
      data-gloom-role="chat-image-lightbox"
      style={{ padding: 8, gap: 6, alignItems: "center", minWidth: 240 }}
    >
      {failed ? (
        <Box alignItems="center" justifyContent="center" style={{ width: 320, height: 200 }}>
          <Text fg={colors.textMuted}>{t("Image unavailable")}</Text>
        </Box>
      ) : createElement("img", {
        key: attachment.url,
        src: attachment.url,
        alt,
        draggable: false,
        style: {
          display: "block",
          maxWidth: "calc(100vw - 96px)",
          maxHeight: "calc(100vh - 128px)",
          width: "auto",
          height: "auto",
          objectFit: "contain",
          borderRadius: 4,
        },
        onError: () => setFailedUrl(attachment.url),
      })}
      <Box flexDirection="row" style={{ alignItems: "center", gap: 8, alignSelf: "stretch" }}>
        {count > 1 && (
          <>
            <IconButton icon="back" label="Previous Image" shortcut="Left" onPress={() => step(-1)} />
            <Text fg={colors.textMuted}>{`${index + 1} / ${count}`}</Text>
            <IconButton icon="chevron-right" label="Next Image" shortcut="Right" onPress={() => step(1)} />
          </>
        )}
        <Text fg={colors.textMuted} style={{ flex: "1 1 auto", minWidth: 0 }}>
          {attachment.width > 0 ? `${attachment.width}x${attachment.height} · ${formatChatImageSize(attachment.size)}` : ""}
        </Text>
        <Button label={t("Open in Browser")} compact onPress={() => { void rendererHost.openExternal(attachment.url); }} />
        <IconButton icon="close" label="Close" shortcut="Esc" onPress={dismiss} />
      </Box>
    </Box>
  );
}
