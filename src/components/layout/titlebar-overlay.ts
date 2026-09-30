import { detectPlatform } from "../../utils/platform";

const TITLEBAR_TRAFFIC_LIGHT_WIDTH = 8;
export const TITLEBAR_OVERLAY_HEIGHT_PX = 28;

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
  return detectPlatform(options.platform) === "darwin" ? TITLEBAR_TRAFFIC_LIGHT_WIDTH : 0;
}
