import type { ChatMessage } from "../../../../api-client";
import { CHAT_COMPOSER_MAX_ROWS } from "../layout";
import {
  getChannelSidebarWidth,
  shouldShowChannelSidebar,
} from "../sidebar";
import { getChatComposerAreaHeight } from "./composer";

export function resolveChatContentWidthMetrics({
  width,
  height,
  channelCount,
  nativePaneChrome,
  sidebarWidth,
}: {
  width: number;
  height: number;
  channelCount: number;
  nativePaneChrome: boolean | undefined;
  /** Width the person dragged the sidebar to; null follows the pane width. */
  sidebarWidth?: number | null;
}) {
  const showChannelSidebar = shouldShowChannelSidebar(channelCount, width, height);
  const channelSidebarWidth = showChannelSidebar
    ? getChannelSidebarWidth(width, nativePaneChrome === true, sidebarWidth)
    : 0;
  const chatWidth = Math.max(width - channelSidebarWidth, 1);
  const contentWidth = Math.max(chatWidth - 2, 1);
  const composerPrefixWidth = nativePaneChrome ? 0 : 3;
  const composerTextWidth = Math.max(contentWidth - composerPrefixWidth, 1);
  const composerWidth = nativePaneChrome ? chatWidth : contentWidth;
  const messageBodyWidth = Math.max(contentWidth - 4, 1);

  return {
    channelSidebarWidth,
    chatWidth,
    composerTextWidth,
    composerWidth,
    contentWidth,
    messageBodyWidth,
    showChannelSidebar,
  };
}

export function resolveChatContentHeightMetrics({
  canSend,
  composerRows,
  editingMessage,
  height,
  mentionSuggestionCount,
  nativePaneChrome,
  replyTo,
}: {
  canSend: boolean;
  composerRows: number;
  editingMessage: ChatMessage | null;
  height: number;
  mentionSuggestionCount?: number;
  nativePaneChrome: boolean | undefined;
  replyTo: ChatMessage | null;
}) {
  const composerHeight = canSend
    ? nativePaneChrome
      ? Math.min(CHAT_COMPOSER_MAX_ROWS + 1, Math.max(2, composerRows + 1))
      : composerRows
    : 0;
  const inputAreaHeight = getChatComposerAreaHeight({
    canSend,
    composerHeight,
    editingMessage,
    mentionSuggestionCount,
    nativePaneChrome,
    replyTo,
  });
  const topSeparatorHeight = nativePaneChrome ? 0 : 1;
  const footerSeparatorHeight = !nativePaneChrome && !canSend ? 1 : 0;
  const messageAreaHeight = Math.max(1, height - topSeparatorHeight - footerSeparatorHeight - inputAreaHeight);

  return {
    composerHeight,
    footerSeparatorHeight,
    inputAreaHeight,
    messageAreaHeight,
    topSeparatorHeight,
  };
}
