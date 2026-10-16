import { createElement, useState } from "react";
import type { ChatAttachment } from "../../../../api-client";
import { IconButton } from "../../../../components/ui";
import { tf } from "../../../../i18n";
import { Box, Text, TextAttributes } from "../../../../ui";
import { blendHex, colors } from "../../../../theme/colors";
import { useThemeColors } from "../../../../theme/theme-context";
import { formatInlinePreview } from "../layout";
import { wirePaneTarget, type ChatMessagePaneLink } from "../pane-links/model";
import { chatPaneLinkPane, useSharePreview } from "../pane-links/previews";
import type { ComposerShareLink } from "../pane-links/composer";
import { DESKTOP_DRAFT_STRIP_STYLE } from "../attachments/desktop";

/**
 * A chip for something a message opens in the terminal: a shared pane (its
 * title and the pane it is, with the picture its sender posted when there is
 * one) or a Gloom Wire post's story or calendar. It always takes the same
 * room, before and after the share is read, so the transcript never moves.
 */

interface ChatPaneChipContent {
  title: string;
  /** The pane it opens, then anything the link itself says (a calendar's day). */
  detail: string;
  /** The opened pane's letter, where there is no picture. */
  icon: string;
}

/** What a chip says, from the share or the post and nothing of the reader's own. */
function useChatPaneChipContent(link: ChatMessagePaneLink): ChatPaneChipContent {
  const shareId = link.kind === "share" ? link.id : "";
  const preview = useSharePreview(shareId);
  if (link.kind === "share") {
    if (preview.status !== "ready") return { title: link.url, detail: "", icon: "" };
    const pane = chatPaneLinkPane(preview.paneId);
    return {
      title: preview.title,
      detail: pane && pane.name !== preview.title ? pane.name : "",
      icon: pane?.icon ?? "",
    };
  }
  const target = wirePaneTarget(link.link);
  const pane = chatPaneLinkPane(target.paneId);
  return { title: pane?.name ?? target.name, detail: target.day ?? "", icon: pane?.icon ?? "" };
}

interface DomEventLike {
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Each kind of chip keeps one height, known before anything loads: a share
 * with its picture, a share without one, and a Wire post's one-line chip.
 */
const PICTURE_CHIP_HEIGHT = 74;
const SHARE_CHIP_HEIGHT = 48;
const COMPACT_CHIP_HEIGHT = 28;
const THUMB = { width: 112, height: 64 };
const ICON_SIZE = 38;
const CHIP_MAX_WIDTH = 420;

export function DesktopChatPaneChip({
  link,
  preview,
  dimmed,
  onOpen,
  onPreviewError,
  onRemove,
}: {
  link: ChatMessagePaneLink;
  /** The picture the sender posted with the link: the chip's thumbnail. */
  preview?: ChatAttachment | null;
  dimmed: boolean;
  onOpen: (link: ChatMessagePaneLink) => void;
  /** The picture did not load, perhaps because its signed link expired. */
  onPreviewError?: (attachment: ChatAttachment) => void;
  /** In the composer: the x at the chip's end that takes the link back out. */
  onRemove?: () => void;
}) {
  const themeColors = useThemeColors();
  const content = useChatPaneChipContent(link);
  const [hovered, setHovered] = useState(false);
  // A fresh copy of the message brings a fresh link, which gets its own try.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const compact = link.kind === "wire";
  const height = compact ? COMPACT_CHIP_HEIGHT : preview ? PICTURE_CHIP_HEIGHT : SHARE_CHIP_HEIGHT;
  const border = hovered ? themeColors.borderFocused : blendHex(themeColors.border, themeColors.bg, 0.35);
  const surface = blendHex(themeColors.panel, themeColors.bg, hovered ? 0.2 : 0.5);
  const showPicture = !!preview && failedUrl !== preview.url;
  const leadSize = compact ? 18 : ICON_SIZE;
  const lead = showPicture
    ? createElement("img", {
      key: "picture",
      src: preview!.url,
      alt: "",
      width: THUMB.width,
      height: THUMB.height,
      loading: "lazy",
      decoding: "async",
      draggable: false,
      onError: () => {
        setFailedUrl(preview!.url);
        onPreviewError?.(preview!);
      },
      style: {
        width: THUMB.width,
        height: THUMB.height,
        flex: "none",
        objectFit: "cover",
        objectPosition: "top left",
        borderRadius: 3,
        display: "block",
        background: blendHex(themeColors.panel, themeColors.bg, 0.5),
      },
    })
    : createElement("span", {
      key: "icon",
      "aria-hidden": true,
      style: {
        width: leadSize,
        height: leadSize,
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 3,
        fontWeight: 600,
        fontSize: compact ? "0.86em" : "1em",
        color: themeColors.textBright,
        background: blendHex(themeColors.panel, themeColors.text, 0.14),
      },
    }, content.icon);
  const line = (text: string, tone: "title" | "detail") => createElement("span", {
    key: tone,
    style: {
      display: "block",
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: tone === "title" ? themeColors.textBright : themeColors.textMuted,
      fontWeight: tone === "title" ? 600 : 400,
      fontSize: tone === "title" ? undefined : "0.92em",
    },
  }, text);
  const label = [content.title, content.detail].filter(Boolean).join(", ");
  const text = compact
    ? createElement("span", {
      key: "text",
      style: { display: "flex", flexDirection: "row", gap: 6, minWidth: 0, alignItems: "baseline" },
    }, line(content.title, "title"), content.detail ? line(content.detail, "detail") : null)
    : createElement("span", {
      key: "text",
      style: { display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0, flex: "1 1 auto", gap: 1 },
    }, line(content.title, "title"), line(content.detail, "detail"));
  const frame = {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: compact ? 6 : 8,
    height,
    width: compact ? "auto" : `min(100%, ${CHIP_MAX_WIDTH}px)`,
    maxWidth: "100%",
    flex: "none",
    margin: "2px 0",
    padding: compact ? "0 10px 0 5px" : "4px 10px 4px 4px",
    border: `1px solid ${border}`,
    borderRadius: 6,
    background: surface,
    opacity: dimmed ? 0.6 : 1,
    overflow: "hidden",
  };
  const pressable = {
    "aria-label": label || undefined,
    title: link.kind === "share" ? link.url : undefined,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    // A press on the chip is not a press on the row behind it.
    onMouseDown: (event: DomEventLike) => event.stopPropagation(),
    onClick: (event: DomEventLike) => {
      event.stopPropagation();
      onOpen(link);
    },
  };
  const buttonReset = { cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left" };
  const dataAttributes = {
    "data-gloom-role": "chat-pane-chip",
    "data-gloom-pane-link": link.kind === "share" ? `share:${link.id}` : link.link.kind,
  };
  if (!onRemove) {
    return createElement("button", { type: "button", ...dataAttributes, ...pressable, style: { ...frame, ...buttonReset } }, lead, text);
  }
  // The same chip with its x inside the frame, where a waiting image keeps its own.
  return createElement("div", { ...dataAttributes, style: { ...frame, paddingRight: 4 } },
    createElement("button", {
      key: "open",
      type: "button",
      ...pressable,
      style: {
        ...buttonReset,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: frame.gap,
        flex: "1 1 auto",
        minWidth: 0,
        height: "100%",
        padding: 0,
        border: "none",
        background: "transparent",
      },
    }, lead, text),
    <IconButton key="remove" icon="close" label={tf("Remove {name}", { name: content.title })} onPress={onRemove} />);
}

/**
 * The share links waiting in the composer, above the field: the chips the
 * message will show, each with its x. A draft from an older app can hold the
 * same link twice, so a chip is known by its place: its x takes out that one.
 */
export function DesktopComposerPaneChips({
  links,
  onOpen,
  onRemove,
}: {
  links: readonly ComposerShareLink[];
  onOpen: (link: ChatMessagePaneLink) => void;
  /** Takes out the chip at this place in `links`. */
  onRemove: (index: number) => void;
}) {
  if (links.length === 0) return null;
  return (
    <Box flexDirection="column" data-gloom-role="chat-draft-links" style={DESKTOP_DRAFT_STRIP_STYLE}>
      {links.map((link, index) => (
        <DesktopChatPaneChip key={`${index}:${link.id}`} link={link} dimmed={false} onOpen={onOpen} onRemove={() => onRemove(index)} />
      ))}
    </Box>
  );
}

/** The terminal's composer rows for waiting share links: the chip a message draws, then its x at the row's end. */
export function TerminalComposerPaneChips({
  links,
  width,
  onOpen,
  onRemove,
}: {
  links: readonly ComposerShareLink[];
  width: number;
  onOpen: (link: ChatMessagePaneLink) => void;
  /** Takes out the chip at this place in `links`, as on the desktop. */
  onRemove: (index: number) => void;
}) {
  // Lined up with the field's text after its prompt, as a message's chips line up with its text.
  const inset = 3;
  const removeWidth = 3;
  return (
    <>
      {links.map((link, index) => (
        <Box key={`${index}:${link.id}`} width={width} height={1} flexDirection="row">
          <Box width={inset} />
          <TerminalChatPaneChip
            link={link}
            width={Math.max(1, width - inset - removeWidth - 1)}
            selected={false}
            selectedTextColor={colors.textBright}
            onOpen={onOpen}
          />
          <Box flexGrow={1} />
          <TerminalComposerChipRemove link={link} onRemove={() => onRemove(index)} />
        </Box>
      ))}
    </>
  );
}

function TerminalComposerChipRemove({ link, onRemove }: { link: ComposerShareLink; onRemove: () => void }) {
  const content = useChatPaneChipContent(link);
  return <IconButton icon="close" label={tf("Remove {name}", { name: content.title })} onPress={onRemove} />;
}

/** One row in the terminal: the pane's letter, the title and the pane, cut to the line. */
export function TerminalChatPaneChip({
  link,
  width,
  selected,
  selectedTextColor,
  onOpen,
}: {
  link: ChatMessagePaneLink;
  width: number;
  selected: boolean;
  selectedTextColor: string;
  onOpen: (link: ChatMessagePaneLink) => void;
}) {
  const content = useChatPaneChipContent(link);
  const icon = content.icon ? ` ${content.icon} ` : " ";
  const text = formatInlinePreview(
    [content.title, content.detail].filter(Boolean).join(" · "),
    Math.max(width - icon.length - 1, 1),
  );
  return (
    <Box
      height={1}
      flexDirection="row"
      backgroundColor={blendHex(colors.panel, colors.text, 0.14)}
      onMouseDown={(event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        onOpen(link);
      }}
    >
      <Text fg={selected ? selectedTextColor : colors.textBright} attributes={TextAttributes.BOLD}>{icon}</Text>
      <Text fg={selected ? selectedTextColor : colors.text}>{`${text} `}</Text>
    </Box>
  );
}
