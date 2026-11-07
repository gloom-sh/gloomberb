import { createElement, useState } from "react";
import { tf } from "../../i18n";
import { Box, Span, Text, TextAttributes } from "../../ui";
import { blendHex, colors } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { RADIUS } from "../../theme/ui-tokens";
import { truncateWithEllipsis, wrapTextLines } from "../../utils/text-wrap";
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
  /** `item` only: a line or two of what the item says, under its title. */
  excerpt?: string;
}

/**
 * - `card`: a shared pane, two lines beside its square (or the picture its sender posted).
 * - `item`: a shared pane and what it was on: the item's title, a line or two
 *   of it, and under them the pane it opens as the `line` chip draws it (or
 *   beside them, the picture its sender posted).
 * - `line`: one line, as a Wire post's story or calendar.
 * - `inline`: the height of the line of text it is written in, as a function in a message.
 */
type PaneLinkChipVariant = "card" | "item" | "line" | "inline";

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
/** An item's title line, two lines of excerpt and its pane's line chip, inside the frame's air. */
const ITEM_CHIP_HEIGHT = 96;
/** Three lines for the title and the excerpt between them. */
const ITEM_TEXT_LINES = 3;
const ITEM_TEXT_LINE = 17;
const THUMB = { width: 112, height: 64 };
/** As tall as an item card's content, at the shape of the picture a share posts. */
const ITEM_THUMB = { width: 142, height: 80 };
const ICON_SIZE = 38;
const LINE_ICON_SIZE = 18;
const CHIP_MAX_WIDTH = 420;
const LINE_PADDING = "0 10px 0 5px";
/** An item card's air: a picture sits as close to the frame as a card's square does. */
const ITEM_PADDING = "var(--gloom-space-xs) var(--gloom-space-sm)";

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
  const item = variant === "item";
  const height = compact ? LINE_CHIP_HEIGHT : item ? ITEM_CHIP_HEIGHT : picture ? PICTURE_CHIP_HEIGHT : CARD_CHIP_HEIGHT;
  const border = lit ? themeColors.borderFocused : blendHex(themeColors.border, themeColors.bg, 0.35);
  const surface = blendHex(themeColors.panel, themeColors.bg, lit ? 0.2 : 0.5);
  const label = [content.title, content.excerpt, content.detail].filter(Boolean).join(", ");
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
  const thumb = item ? ITEM_THUMB : THUMB;
  const square = (size: number, small: boolean, key: string) => createElement("span", {
    key,
    "aria-hidden": true,
    style: {
      width: size,
      height: size,
      flex: "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: RADIUS.sm,
      fontWeight: 600,
      fontSize: small ? "0.86em" : "1em",
      color: themeColors.textBright,
      background: leadSurface(themeColors.panel, themeColors.text, item && lit),
    },
  }, content.icon);
  const lead = showPicture
    ? createElement("img", {
      key: "picture",
      src: picture!.url,
      alt: "",
      width: thumb.width,
      height: thumb.height,
      loading: "lazy",
      decoding: "async",
      draggable: false,
      onError: () => {
        setFailedUrl(picture!.url);
        onPictureError?.();
      },
      style: {
        width: thumb.width,
        height: thumb.height,
        flex: "none",
        objectFit: "cover",
        objectPosition: "top left",
        borderRadius: 3,
        display: "block",
        background: blendHex(themeColors.panel, themeColors.bg, 0.5),
      },
    })
    // An item's square is in its line chip, under the text.
    : item ? null : square(compact ? LINE_ICON_SIZE : ICON_SIZE, compact, "icon");
  const line = (text: string, tone: "title" | "detail", key: string = tone) => createElement("span", {
    key,
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
  // The line chip's frame: a Wire post's story, and the pane an item card opens.
  const lineFrame = {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: LINE_CHIP_HEIGHT,
    padding: LINE_PADDING,
    border: `1px solid ${border}`,
    borderRadius: RADIUS.md,
    background: surface,
    overflow: "hidden",
  };
  const text = compact
    ? createElement("span", {
      key: "text",
      style: { display: "flex", flexDirection: "row", gap: 6, minWidth: 0, alignItems: "baseline" },
    }, line(content.title, "title"), content.detail ? line(content.detail, "detail") : null)
    : item
      ? createElement("span", {
        key: "text",
        style: { display: "flex", flexDirection: "column", minWidth: 0, flex: "1 1 auto", height: "100%" },
      },
      // The title, then the excerpt in the lines it leaves: a long headline
      // wraps rather than being cut, and the text never outgrows its lines.
      createElement("span", {
        key: "words",
        style: {
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: ITEM_TEXT_LINES,
          overflow: "hidden",
          minWidth: 0,
          flex: "none",
          height: ITEM_TEXT_LINE * ITEM_TEXT_LINES,
          lineHeight: `${ITEM_TEXT_LINE}px`,
          overflowWrap: "anywhere",
        },
      },
      createElement("span", { key: "title", style: { color: themeColors.textBright, fontWeight: "var(--gloom-weight-bold)" } }, content.title),
      content.excerpt ? createElement("br", { key: "break" }) : null,
      content.excerpt ? createElement("span", { key: "excerpt", style: { color: themeColors.text } }, content.excerpt) : null),
      content.detail
        ? createElement("span", {
          key: "pane",
          style: { ...lineFrame, alignSelf: "flex-start", maxWidth: "100%", marginTop: "auto" },
        }, square(LINE_ICON_SIZE, true, "pane-icon"), line(content.detail, "title", "pane-name"))
        : null)
      : createElement("span", {
        key: "text",
        style: { display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0, flex: "1 1 auto", gap: 1 },
      }, line(content.title, "title"), line(content.detail, "detail"));
  const frame = {
    ...(compact ? {
      ...lineFrame,
      width: "auto",
      maxWidth: fit ? `min(100%, ${CHIP_MAX_WIDTH}px)` : "100%",
    } : {
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "row",
      alignItems: item ? "stretch" : "center",
      gap: 8,
      height,
      width: fit ? "auto" : `min(100%, ${CHIP_MAX_WIDTH}px)`,
      maxWidth: fit ? `min(100%, ${CHIP_MAX_WIDTH}px)` : "100%",
      padding: item ? ITEM_PADDING : "4px 10px 4px 4px",
      border: `1px solid ${border}`,
      borderRadius: 6,
      background: surface,
      overflow: "hidden",
    }),
    flex: "none",
    margin: "2px 0",
    opacity: dimmed ? 0.6 : 1,
  };
  if (!onRemove) {
    return createElement(element, { ...elementProps, ...dataAttributes, ...pressable, style: { ...frame, ...buttonReset } }, lead, text);
  }
  // The same chip with its x inside the frame, where a waiting image keeps its own
  // (an item card's at its top corner, beside the title).
  return createElement("div", { ...dataAttributes, style: { ...frame, paddingRight: 4, ...(item ? { alignItems: "flex-start" } : {}) } },
    createElement(element, {
      key: "open",
      ...elementProps,
      ...pressable,
      style: {
        ...buttonReset,
        display: "flex",
        flexDirection: "row",
        alignItems: item ? "stretch" : "center",
        ...(item ? { alignSelf: "stretch" } : {}),
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

/** The rows a shared item's card takes in the terminal: its title and excerpt, and the pane it opens. */
export const TERMINAL_ITEM_CHIP_ROWS = 3;
const TERMINAL_ITEM_TEXT_ROWS = TERMINAL_ITEM_CHIP_ROWS - 1;

/** `text` wrapped to `width`, in at most `rows` rows, the last cut with an ellipsis when it does not fit. */
function clampedRows(text: string, width: number, rows: number): string[] {
  if (rows <= 0 || !text) return [];
  const lines = wrapTextLines(text, width);
  if (lines.length <= rows) return lines;
  return [...lines.slice(0, rows - 1), truncateWithEllipsis(lines.slice(rows - 1).join(" "), width)];
}

/**
 * The `item` card in the terminal: the chip's fill as a block, with the item's
 * title and what it says in the two rows the title leaves, and under them its
 * pane as the one-row chip draws it. As wide as its longest line, up to
 * `width`; always three rows.
 */
export function TerminalPaneLinkItemCard({
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
  /** Unset: the card says what it is, in muted text, and opens nothing. */
  onOpen?: () => void;
}) {
  const oneLine = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const title = oneLine(content.title);
  const excerpt = oneLine(content.excerpt);
  const pane = content.detail ? { title: content.detail, detail: "", icon: content.icon } : null;
  const paneWidth = pane ? (pane.icon ? pane.icon.length + 2 : 1) + pane.title.length + 1 : 0;
  const cardWidth = Math.max(1, Math.min(width, Math.max(title.length, excerpt.length, paneWidth - 2) + 2));
  const textWidth = Math.max(cardWidth - 2, 1);
  // The title wraps, then the excerpt takes the rows it leaves, as on the desktop.
  const titleRows = clampedRows(title, textWidth, TERMINAL_ITEM_TEXT_ROWS);
  const excerptRows = excerpt ? clampedRows(excerpt, textWidth, TERMINAL_ITEM_TEXT_ROWS - titleRows.length) : [];
  const fill = leadSurface(colors.panel, colors.text);
  const titleColor = selected ? selectedTextColor : onOpen ? colors.textBright : colors.textMuted;
  const excerptColor = selected ? selectedTextColor : colors.text;
  const rows = [
    ...titleRows.map((text) => ({ text, color: titleColor, bold: true })),
    ...excerptRows.map((text) => ({ text, color: excerptColor, bold: false })),
  ];
  return (
    <Box
      flexDirection="column"
      width={cardWidth}
      height={TERMINAL_ITEM_CHIP_ROWS}
      backgroundColor={fill}
      onMouseDown={onOpen ? (event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        onOpen();
      } : undefined}
    >
      {Array.from({ length: TERMINAL_ITEM_TEXT_ROWS }, (_, index) => {
        const row = rows[index];
        return (
          <Box key={index} height={1}>
            {row ? <Text fg={row.color} attributes={row.bold ? TextAttributes.BOLD : 0}>{` ${row.text}`}</Text> : null}
          </Box>
        );
      })}
      <Box height={1} flexDirection="row">
        {pane ? <TerminalPaneLinkChip content={pane} width={cardWidth} selected={selected} selectedTextColor={selectedTextColor} onOpen={onOpen} /> : null}
      </Box>
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
