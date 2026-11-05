import { createElement, useState } from "react";
import { tf } from "../../i18n";
import { Box, Span, Text, TextAttributes } from "../../ui";
import { blendHex, colors } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { truncateWithEllipsis } from "../../utils/text-wrap";
import { IconButton } from "./icon";

/**
 * The chip for a pane something opens: a pane shared in chat, a Gloom Wire
 * post's story or calendar, a function written in a message, a source of an
 * Ask Gloom answer. One chip for all of them, so they read as one thing and
 * open as one thing; a question Ask Gloom suggests asking next is the same
 * chip, its key in the square.
 */
export interface PaneLinkChipContent {
  title: string;
  /** The pane it opens, then anything the link itself says (a calendar's day). */
  detail: string;
  /** The lead square: the opened pane's letter, or what ties the chip to its text (a source's number, a key). */
  icon: string;
}

/**
 * - `card`: a shared pane, two lines beside its square (or the picture its sender posted).
 * - `line`: one line, as a Wire post's story or calendar.
 * - `inline`: the height of the line of text it is written in, as a function in a message.
 */
type PaneLinkChipVariant = "card" | "line" | "inline";

interface DomEventLike {
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Each kind of chip keeps one height, known before anything loads, so a list
 * of them never moves as they fill in.
 */
const PICTURE_CHIP_HEIGHT = 74;
const CARD_CHIP_HEIGHT = 48;
const LINE_CHIP_HEIGHT = 28;
const THUMB = { width: 112, height: 64 };
const ICON_SIZE = 38;
const CHIP_MAX_WIDTH = 420;

/** The lead square's colour, which an inline marker shares so the two read as one family. */
function leadSurface(panel: string, text: string, hovered = false): string {
  return blendHex(panel, text, hovered ? 0.24 : 0.14);
}

interface DesktopPaneLinkChipProps {
  content: PaneLinkChipContent;
  variant: PaneLinkChipVariant;
  /** The picture its sender posted with the link: a card's thumbnail. */
  picture?: { url: string } | null;
  dimmed?: boolean;
  /** Unset: the chip says what it is and opens nothing. */
  onOpen?: () => void;
  /** The picture did not load, perhaps because its signed link expired. */
  onPictureError?: () => void;
  /** The x at the chip's end that takes the link back out (a composer's waiting link). */
  onRemove?: () => void;
  /** The hover text: a share's address, a function's name. */
  tooltip?: string;
  /** `data-gloom-role`, for the pane's own checks and tests. */
  role: string;
  /** `data-gloom-pane-link`: what the chip opens, in a word. */
  linkKey: string;
  /** A card as wide as its words (up to the usual width), to sit beside others in a row. */
  fit?: boolean;
}

export function DesktopPaneLinkChip({
  content,
  variant,
  picture,
  dimmed = false,
  onOpen,
  onPictureError,
  onRemove,
  tooltip,
  role,
  linkKey,
  fit = false,
}: DesktopPaneLinkChipProps) {
  const themeColors = useThemeColors();
  const [hovered, setHovered] = useState(false);
  // A fresh copy of the message brings a fresh link, which gets its own try.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const pressableChip = !!onOpen;
  const lit = hovered && pressableChip;
  const compact = variant === "line";
  const height = compact ? LINE_CHIP_HEIGHT : picture ? PICTURE_CHIP_HEIGHT : CARD_CHIP_HEIGHT;
  const border = lit ? themeColors.borderFocused : blendHex(themeColors.border, themeColors.bg, 0.35);
  const surface = blendHex(themeColors.panel, themeColors.bg, lit ? 0.2 : 0.5);
  const label = [content.title, content.detail].filter(Boolean).join(", ");
  const pressable = pressableChip
    ? {
      "aria-label": label || undefined,
      title: tooltip,
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      // A press on the chip is not a press on the row behind it.
      onMouseDown: (event: DomEventLike) => event.stopPropagation(),
      onClick: (event: DomEventLike) => {
        event.stopPropagation();
        onOpen();
      },
    }
    : { "aria-label": label || undefined, title: tooltip };
  const buttonReset = { cursor: pressableChip ? "pointer" : "default", font: "inherit", color: "inherit", textAlign: "left" };
  const element = pressableChip ? "button" : "div";
  const elementProps = pressableChip ? { type: "button" } : {};
  const dataAttributes = { "data-gloom-role": role, "data-gloom-pane-link": linkKey };
  if (variant === "inline") {
    // The same frame at the height of the line of text it is written in: the
    // kit's chip, 16px in an 18px row, as the ticker chips beside it.
    return createElement(element, {
      ...elementProps,
      ...dataAttributes,
      ...pressable,
      style: {
        ...buttonReset,
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        height: "calc(100% - 2px)",
        maxWidth: "100%",
        padding: "0 var(--gloom-space-sm)",
        border: `1px solid ${border}`,
        borderRadius: "var(--gloom-radius-sm)",
        background: surface,
        opacity: dimmed ? 0.6 : 1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "pre",
        color: themeColors.textBright,
        fontWeight: "var(--gloom-weight-bold)",
      },
    }, content.title);
  }
  const showPicture = !!picture && failedUrl !== picture.url;
  const leadSize = compact ? 18 : ICON_SIZE;
  const lead = showPicture
    ? createElement("img", {
      key: "picture",
      src: picture!.url,
      alt: "",
      width: THUMB.width,
      height: THUMB.height,
      loading: "lazy",
      decoding: "async",
      draggable: false,
      onError: () => {
        setFailedUrl(picture!.url);
        onPictureError?.();
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
        background: leadSurface(themeColors.panel, themeColors.text),
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
    width: compact || fit ? "auto" : `min(100%, ${CHIP_MAX_WIDTH}px)`,
    maxWidth: fit ? `min(100%, ${CHIP_MAX_WIDTH}px)` : "100%",
    flex: "none",
    margin: "2px 0",
    padding: compact ? "0 10px 0 5px" : "4px 10px 4px 4px",
    border: `1px solid ${border}`,
    borderRadius: 6,
    background: surface,
    opacity: dimmed ? 0.6 : 1,
    overflow: "hidden",
  };
  if (!onRemove) {
    return createElement(element, { ...elementProps, ...dataAttributes, ...pressable, style: { ...frame, ...buttonReset } }, lead, text);
  }
  // The same chip with its x inside the frame, where a waiting image keeps its own.
  return createElement("div", { ...dataAttributes, style: { ...frame, paddingRight: 4 } },
    createElement(element, {
      key: "open",
      ...elementProps,
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

/** One row in the terminal: the lead square, then the title and the pane, cut to the line. */
export function TerminalPaneLinkChip({
  content,
  width,
  selected = false,
  selectedTextColor = colors.textBright,
  onOpen,
}: {
  content: PaneLinkChipContent;
  width: number;
  selected?: boolean;
  selectedTextColor?: string;
  /** Unset: the chip says what it is, in muted text, and opens nothing. */
  onOpen?: () => void;
}) {
  const icon = content.icon ? ` ${content.icon} ` : " ";
  const text = truncateWithEllipsis(
    [content.title, content.detail].filter(Boolean).join(" · ").replace(/\s+/g, " ").trim(),
    Math.max(width - icon.length - 1, 1),
  );
  const fg = selected ? selectedTextColor : onOpen ? colors.text : colors.textMuted;
  return (
    <Box
      height={1}
      flexDirection="row"
      backgroundColor={leadSurface(colors.panel, colors.text)}
      onMouseDown={onOpen ? (event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        onOpen();
      } : undefined}
    >
      <Text fg={selected ? selectedTextColor : onOpen ? colors.textBright : colors.textMuted} attributes={TextAttributes.BOLD}>{icon}</Text>
      <Text fg={fg}>{`${text} `}</Text>
    </Box>
  );
}

/**
 * A chip's lead square written inside a line of text: a figure's source
 * number in an Ask Gloom answer, which opens what the chip of the same number
 * opens. The terminal draws it as the chip's square (`▐2▌`); the desktop and
 * the web as the same square at the text's size, pressed to open.
 */
export function PaneLinkMarker({
  label,
  native,
  onOpen,
}: {
  /** What it stands for (`3`); the terminal pads it to the width of the `[3]` it replaces (`▐3▌`). */
  label: string;
  /** The desktop and the web, where part of a line can be pressed. */
  native: boolean;
  onOpen: () => void;
}) {
  const themeColors = useThemeColors();
  const [hovered, setHovered] = useState(false);
  const text = label.trim();
  if (!native) {
    // Half blocks in the square's colour pad it, not spaces: the terminal
    // wraps at any space, and a line must never end inside the square.
    const surface = leadSurface(colors.panel, colors.text);
    return (
      <>
        <Span fg={surface}>{"\u2590"}</Span>
        <Span fg={colors.textBright} bg={surface} attributes={TextAttributes.BOLD}>{text}</Span>
        <Span fg={surface}>{"\u258c"}</Span>
      </>
    );
  }
  return (
    <Span
      fg={themeColors.textBright}
      attributes={TextAttributes.BOLD}
      role="link"
      data-gloom-role="pane-link-marker"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={(event: { button?: number; preventDefault?: () => void; stopPropagation?: () => void }) => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        onOpen();
      }}
      // Inline, not inline-block: a line may break before an inline block
      // and leave the full stop after a figure's square on a line of its own.
      // The padding makes a one-digit square as wide as it is tall.
      style={{
        display: "inline",
        padding: "0 0.45em",
        margin: "0 0.1em",
        borderRadius: "var(--gloom-radius-sm)",
        fontSize: "var(--gloom-type-caption)",
        lineHeight: "1.3",
        cursor: "pointer",
        background: leadSurface(themeColors.panel, themeColors.text, hovered),
      }}
    >
      {text}
    </Span>
  );
}
