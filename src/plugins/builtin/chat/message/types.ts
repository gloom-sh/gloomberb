import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import type { ChatAttachment, ChatMessage, ChatUserSummary } from "../../../../api-client";
import type { BoxRenderable } from "../../../../ui";
import type { ChatMessagePaneLink } from "../pane-links/model";

/** The name or @mention a user's card opens beside, where the renderer places cards next to it. */
export type ChatUserAnchor = BoxRenderable | null;

/** The pointer event a user menu opens from. */
export interface ChatUserContextMenuEvent {
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export interface ChatMessageBaseProps {
  msg: ChatMessage;
  index: number;
  messages: ChatMessage[];
  selectedIdx: number;
  hoveredIdx: number | null;
  /** A message the reader was sent to, marked for a moment. */
  highlighted?: boolean;
  canSend: boolean;
  catalog: Record<string, InlineTickerCatalogEntry>;
  userByUsername: Map<string, ChatUserSummary>;
  openTicker: (symbol: string) => void;
  onUserHover: (user: ChatUserSummary, anchor?: ChatUserAnchor) => void;
  onUserHoverEnd: () => void;
  onUserActivate?: (user: ChatUserSummary, anchor?: ChatUserAnchor) => void;
  /** A right-click on a name or @mention: the user's own menu. */
  onUserContextMenu?: (user: ChatUserSummary, event: ChatUserContextMenuEvent, anchor?: ChatUserAnchor) => void;
  beginReplyTo: (index: number, options?: { deferFocus?: boolean }) => void;
  beginEditMessage: (index: number, options?: { deferFocus?: boolean }) => boolean;
  jumpToMessage: (messageId: string) => void;
  latestEditableMessageId: string | null;
  /** Sends a failed message of yours again. */
  retryMessage?: (index: number) => void;
  /** An image did not load, perhaps because its signed link expired. */
  onImageLoadError?: (attachment: ChatAttachment) => void;
  /** The server takes reactions and you can send: chips toggle and React is on offer. */
  reactionsEnabled?: boolean;
  currentUserId?: string | null;
  /** Adds or takes back your reaction with one emoji. */
  toggleReaction?: (messageId: string, emoji: string) => void;
  /** Opens the reaction picker for a message. */
  openReactionPicker?: (index: number) => void;
  /** The message whose picker is open on the desktop. */
  reactionPickerMessageId?: string | null;
  closeReactionPicker?: () => void;
  /** Opens what a chip under the message stands for: a shared pane, a Wire post's story or calendar. */
  openPaneLink: (link: ChatMessagePaneLink) => void;
}
