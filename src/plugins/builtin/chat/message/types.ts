import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import type { ChatAttachment, ChatMessage, ChatUserSummary } from "../../../../api-client";
import type { BoxRenderable } from "../../../../ui";

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
}
