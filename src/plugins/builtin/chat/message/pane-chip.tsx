import type { ChatAttachment } from "../../../../api-client";
import {
  DesktopPaneLinkChip,
  IconButton,
  TERMINAL_ITEM_CHIP_ROWS,
  TerminalPaneLinkChip,
  TerminalPaneLinkItemCard,
  type PaneLinkChipContent,
} from "../../../../components/ui";
import { tf } from "../../../../i18n";
import { Box } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import { wirePaneTarget, type ChatMessagePaneLink } from "../pane-links/model";
import { chatPaneLinkPane, useSharePreview } from "../pane-links/previews";
import type { ComposerShareLink } from "../pane-links/composer";
import { DESKTOP_DRAFT_STRIP_STYLE } from "../attachments/desktop";

/**
 * A chip for something a message opens in the terminal: a shared pane as a
 * card (the item it was on, a line or two of it and the pane it opens, with
 * the picture its sender posted when there is one), a Gloom Wire post's story
 * or calendar, or a function written in backticks, drawn in its line of text.
 * It always takes the same room, before and after the share is read, so the
 * transcript never moves.
 */

/** The rows a chip takes in the terminal: a share's card, or one row. */
export function terminalChatPaneChipRows(link: ChatMessagePaneLink): number {
  return link.kind === "share" ? TERMINAL_ITEM_CHIP_ROWS : 1;
}

/** What a chip says, from the share or the post and nothing of the reader's own. */
function useChatPaneChipContent(link: ChatMessagePaneLink): PaneLinkChipContent {
  const shareId = link.kind === "share" ? link.id : "";
  const preview = useSharePreview(shareId);
  if (link.kind === "command") return { title: link.query, detail: link.name, icon: "" };
  if (link.kind === "share") {
    if (preview.status !== "ready") return { title: link.url, detail: "", icon: "" };
    const pane = chatPaneLinkPane(preview.paneId);
    // A share from before items says what its pane is, in the pane's own words.
    const item = preview.item ?? { pane: "", title: preview.title, excerpt: preview.description };
    return {
      title: item.title,
      excerpt: item.excerpt ?? "",
      detail: pane?.name ?? item.pane,
      icon: pane?.icon ?? "",
    };
  }
  const target = wirePaneTarget(link.link);
  const pane = chatPaneLinkPane(target.paneId);
  return { title: pane?.name ?? target.name, detail: target.day ?? "", icon: pane?.icon ?? "" };
}

/** The hover text: a share's link, and what a function written in a message is called. */
function chipTooltip(link: ChatMessagePaneLink): string | undefined {
  return link.kind === "share" ? link.url : link.kind === "command" ? link.name : undefined;
}

function chipLinkKey(link: ChatMessagePaneLink): string {
  return link.kind === "share" ? `share:${link.id}` : link.kind === "command" ? `command:${link.query}` : link.link.kind;
}

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
  const content = useChatPaneChipContent(link);
  return (
    <DesktopPaneLinkChip
      content={content}
      variant={link.kind === "command" ? "inline" : link.kind === "wire" ? "line" : "item"}
      picture={link.kind === "command" ? null : preview}
      dimmed={dimmed}
      onOpen={() => onOpen(link)}
      onPictureError={preview ? () => onPreviewError?.(preview) : undefined}
      onRemove={onRemove}
      tooltip={chipTooltip(link)}
      role="chat-pane-chip"
      linkKey={chipLinkKey(link)}
    />
  );
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

/** The terminal's composer rows for waiting share links: the card a message draws, then its x at the end of its first row. */
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
        <Box key={`${index}:${link.id}`} width={width} height={terminalChatPaneChipRows(link)} flexDirection="row">
          <Box width={inset} />
          <TerminalChatPaneChip
            link={link}
            width={Math.max(1, width - inset - removeWidth - 1)}
            selected={false}
            selectedTextColor={colors.textBright}
            onOpen={onOpen}
          />
          <Box flexGrow={1} />
          <Box height={1}>
            <TerminalComposerChipRemove link={link} onRemove={() => onRemove(index)} />
          </Box>
        </Box>
      ))}
    </>
  );
}

function TerminalComposerChipRemove({ link, onRemove }: { link: ComposerShareLink; onRemove: () => void }) {
  const content = useChatPaneChipContent(link);
  return <IconButton icon="close" label={tf("Remove {name}", { name: content.title })} onPress={onRemove} />;
}

/** A share's card in the terminal, or one row: the pane's letter, the title and the pane, cut to the line. */
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
  const Chip = link.kind === "share" ? TerminalPaneLinkItemCard : TerminalPaneLinkChip;
  return (
    <Chip
      content={content}
      width={width}
      selected={selected}
      selectedTextColor={selectedTextColor}
      onOpen={() => onOpen(link)}
    />
  );
}
