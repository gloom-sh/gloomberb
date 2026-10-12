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

/** Chat is optional. The host's Share dialog and Copy link still work with the plugin disabled. */
export interface PaneChatSharing {
  ready(retry: () => void): boolean;
  targets(): Promise<ShareTarget[]>;
  defaultChannel(targets: readonly ShareTarget[]): string;
  includeLink(): boolean;
  setIncludeLink(value: boolean): void;
  post(capture: PaneImageCapture, request: SharePost, content: string): Promise<{ messageId: string }>;
  posted(result: SharePost & { messageId: string }, targets: readonly ShareTarget[]): void;
}

let chat: PaneChatSharing | null = null;
export function registerPaneChatSharing(provider: PaneChatSharing): () => void {
  chat = provider;
  return () => { if (chat === provider) chat = null; };
}

export function getPaneChatSharing(): PaneChatSharing | null {
  return chat;
}
