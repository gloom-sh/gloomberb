import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import type { ChatMessage, ChatUserSummary } from "../../../../api-client";

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
  onUserHover: (user: ChatUserSummary) => void;
  onUserHoverEnd: () => void;
  onUserActivate?: (user: ChatUserSummary) => void;
  beginReplyTo: (index: number, options?: { deferFocus?: boolean }) => void;
  beginEditMessage: (index: number, options?: { deferFocus?: boolean }) => boolean;
  jumpToMessage: (messageId: string) => void;
  latestEditableMessageId: string | null;
}
