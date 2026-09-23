import { createAnimationFrameDriver, installMarketDataFrameDriver, withLoadPacing } from "../../../market-data/frame-scheduler";
import { setAppVisible } from "../../../state/app/activity";

/**
 * DOM renderers (desktop windows and the web app) apply streamed data on
 * animation frames, spaced out while the renders they set off are expensive,
 * and pause market data while their document is hidden: a
 * minimized window, a background tab, another desktop Space. Each desktop
 * window has its own document, so a hidden detached window pauses only its
 * own streams.
 */
export function installDomMarketDataFrames(): () => void {
  installMarketDataFrameDriver(withLoadPacing(createAnimationFrameDriver()));
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof doc.addEventListener !== "function") return () => {};
  const syncVisibility = () => setAppVisible(doc.visibilityState !== "hidden");
  doc.addEventListener("visibilitychange", syncVisibility);
  globalThis.addEventListener?.("pageshow", syncVisibility);
  syncVisibility();
  return () => {
    doc.removeEventListener("visibilitychange", syncVisibility);
    globalThis.removeEventListener?.("pageshow", syncVisibility);
  };
}
