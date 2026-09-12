/// <reference lib="dom" />

/**
 * Screenshot branding for the DOM renderers.
 *
 * Chart bitmaps are opaque, so the wordmark cannot literally sit behind the
 * plot. Instead every chart mounts a faint, always-hidden watermark layer and
 * this attribute on `<html>` reveals all of them at once. Flipping an
 * attribute is synchronous, which lets the pane capture paint the watermark
 * without a React render, and lets the OS screenshot detector toggle it
 * without touching component state.
 */
export const SCREENSHOT_WATERMARK_ATTRIBUTE = "data-gloom-screenshot";

export const CHART_WATERMARK_ROLE = "chart-watermark";

export function isScreenshotWatermarkVisible(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute(SCREENSHOT_WATERMARK_ATTRIBUTE) === "true";
}

export function setScreenshotWatermarkVisible(visible: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (visible) root.setAttribute(SCREENSHOT_WATERMARK_ATTRIBUTE, "true");
  else root.removeAttribute(SCREENSHOT_WATERMARK_ATTRIBUTE);
}
