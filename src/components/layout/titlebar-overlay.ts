export const TITLEBAR_TRAFFIC_LIGHT_WIDTH = 8;
export const TITLEBAR_OVERLAY_HEIGHT_PX = 28;

function currentPlatform(): string {
  const globalWithNavigator = globalThis as typeof globalThis & {
    navigator?: {
      platform?: string;
      userAgentData?: { platform?: string };
    };
  };
  return globalWithNavigator.navigator?.userAgentData?.platform
    ?? globalWithNavigator.navigator?.platform
    ?? "";
}

/**
 * Columns the header leaves free before its first content. macOS parks the
 * traffic lights over them, but takes them away in fullscreen, where the space
 * would just be a gap the eye has to cross.
 */
export function getTitlebarLeadingInset(options: {
  platform?: string;
  windowFullscreen?: boolean;
} = {}): number {
  if (options.windowFullscreen) return 0;
  const platform = options.platform ?? currentPlatform();
  return /mac/i.test(platform) ? TITLEBAR_TRAFFIC_LIGHT_WIDTH : 0;
}
