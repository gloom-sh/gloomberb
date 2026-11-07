import type { ReactNode } from "react";
import type { ChatAttachment } from "../../../../api-client";
import {
  DesktopPaneLinkChip,
  IconButton,
  TerminalPaneLinkChip,
  TerminalPaneLinkItemCard,
  terminalItemCardRows,
  type PaneLinkChipContent,
} from "../../../../components/ui";
import { tf } from "../../../../i18n";
import { Box } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import { wirePaneTarget, type ChatMessagePaneLink } from "../pane-links/model";
import { chatPaneLinkPane, useSharePreview } from "../pane-links/previews";
import { shareCardContent } from "../pane-links/share-card";
import type { ComposerShareLink } from "../pane-links/composer";
import { DESKTOP_DRAFT_STRIP_STYLE } from "../attachments/desktop";

/**
 * A chip for something a message opens in the terminal: a shared pane as a
 * card (the item it was on, a line or two of it and the pane it opens, with
 * the picture its sender posted when there is one), a Gloom Wire post's story
 * or calendar, or a function written in backticks, drawn in its line of text.
 * A share's card is as tall as what it says; the other chips keep one height.
 */

/** What a chip says, from the share or the post and nothing of the reader's own. */
function useChatPaneChipContent(link: ChatMessagePaneLink): PaneLinkChipContent {
  const shareId = link.kind === "share" ? link.id : "";
  const preview = useSharePreview(shareId);
  if (link.kind === "command") return { title: link.query, detail: link.name, icon: "" };
  if (link.kind === "share") return shareCardContent(link.url, preview);
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

/** How wide a waiting link's card is in the terminal's composer of `width`: lined up with the field's text, its x after it. */
export function terminalComposerChipWidth(width: number): number {
  return Math.max(1, width - COMPOSER_CHIP_INSET - COMPOSER_CHIP_REMOVE_WIDTH - 1);
}

// Lined up with the field's text after its prompt, as a message's chips line up with its text.
const COMPOSER_CHIP_INSET = 3;
const COMPOSER_CHIP_REMOVE_WIDTH = 3;

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
  return (
    <>
      {links.map((link, index) => (
        <TerminalChatPaneChipRow
          key={`${index}:${link.id}`}
          link={link}
          width={terminalComposerChipWidth(width)}
          rowProps={{ width }}
          selected={false}
          selectedTextColor={colors.textBright}
          onOpen={onOpen}
          lead={<Box width={COMPOSER_CHIP_INSET} />}
        >
          <Box flexGrow={1} />
          <Box height={1}>
            <TerminalComposerChipRemove link={link} onRemove={() => onRemove(index)} />
          </Box>
        </TerminalChatPaneChipRow>
      ))}
    </>
  );
}

function TerminalComposerChipRemove({ link, onRemove }: { link: ComposerShareLink; onRemove: () => void }) {
  const content = useChatPaneChipContent(link);
  return <IconButton icon="close" label={tf("Remove {name}", { name: content.title || content.detail })} onPress={onRemove} />;
}

/**
 * A chip's row in the terminal, as tall as the chip: a share's card as it
 * reads now, or one row. `lead` goes before the chip and `children` after it.
 */
export function TerminalChatPaneChipRow({
  link,
  width,
  rowProps,
  selected,
  selectedTextColor,
  onOpen,
  lead,
  children,
}: {
  link: ChatMessagePaneLink;
  /** The chip's own width. */
  width: number;
  rowProps: Record<string, unknown>;
  selected: boolean;
  selectedTextColor: string;
  onOpen: (link: ChatMessagePaneLink) => void;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  const content = useChatPaneChipContent(link);
  const share = link.kind === "share";
  const Chip = share ? TerminalPaneLinkItemCard : TerminalPaneLinkChip;
  return (
    <Box {...rowProps} height={share ? terminalItemCardRows(content, width) : 1} flexDirection="row">
      {lead}
      <Chip
        content={content}
        width={width}
        selected={selected}
        selectedTextColor={selectedTextColor}
        onOpen={() => onOpen(link)}
      />
      {children}
    </Box>
  );
}
