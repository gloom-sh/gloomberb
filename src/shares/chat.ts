import type { PaneImageCapture } from "./pane-image";

/**
 * Chat is optional. Report a Bug posts a pane's picture through it and is not
 * offered without it; Share copies a link and does not need it.
 */
export interface PaneChatSharing {
  /** Loads chat's session and channels, so a post can go out. */
  prepare(): Promise<void>;
  post(capture: PaneImageCapture, channelId: string, content: string): Promise<{ messageId: string }>;
  /** Opens a conversation in a chat pane at one of its messages. */
  openMessage(channelId: string, messageId: string): void;
}

let chat: PaneChatSharing | null = null;
export function registerPaneChatSharing(provider: PaneChatSharing): () => void {
  chat = provider;
  return () => { if (chat === provider) chat = null; };
}

export function getPaneChatSharing(): PaneChatSharing | null {
  return chat;
}
