import type { PaneImageCapture } from "./pane-image";

export interface ShareTarget {
  channelId: string;
  label: string;
  description?: string;
}

export interface SharePost {
  channelId: string;
  caption: string;
  includeLink: boolean;
}

/** What a post to chat is for, as the sign-in and verify prompts name it. */
export type ChatPostPurpose = "share" | "bug-report";

/** Chat is optional. The host's Share dialog and Copy link still work with the plugin disabled. */
export interface PaneChatSharing {
  /**
   * Whether the account can post now. When it cannot, says what is missing:
   * a sign-in, which then calls `retry`, or a verified email.
   */
  ready(retry: () => void, purpose?: ChatPostPurpose): boolean;
  targets(): Promise<ShareTarget[]>;
  defaultChannel(targets: readonly ShareTarget[]): string;
  includeLink(): boolean;
  setIncludeLink(value: boolean): void;
  post(capture: PaneImageCapture, request: SharePost, content: string): Promise<{ messageId: string }>;
  posted(result: SharePost & { messageId: string }, targets: readonly ShareTarget[]): void;
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
