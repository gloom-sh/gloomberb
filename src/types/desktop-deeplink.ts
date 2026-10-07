/** @public */
export interface DesktopDeepLink {
  url: string;
}

export interface DesktopDeepLinkBridge {
  subscribe(listener: (deeplink: DesktopDeepLink) => void): () => void;
}
