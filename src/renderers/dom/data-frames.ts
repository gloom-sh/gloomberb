import { createAnimationFrameDriver, installMarketDataFrameDriver, withLoadPacing } from "../../market-data/frame-scheduler";
import { setAppVisible } from "../../state/app/activity";

/** The window's own report of being minimized or shown, for a shell whose page is not always told. */
type NativeVisibilitySource = (listener: (visible: boolean) => void) => () => void;

/**
 * DOM renderers (desktop windows and the web app) apply streamed data on
 * animation frames, spaced out while the renders they set off are expensive,
 * and pause market data while their document is hidden: a
 * minimized window, a background tab, another desktop Space. Each desktop
 * window has its own document, so a hidden window pauses only its own
 * streams; the data stays in the desktop process for the others. Some
 * webviews keep a minimized window's page "visible", so the desktop shell
 * also says when its window is minimized (`nativeVisibility`).
 */
export function installDomMarketDataFrames(nativeVisibility?: NativeVisibilitySource): () => void {
  installMarketDataFrameDriver(withLoadPacing(createAnimationFrameDriver()));
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof doc.addEventListener !== "function") return () => {};
  let nativeVisible = true;
  const syncVisibility = () => setAppVisible(nativeVisible && doc.visibilityState !== "hidden");
  doc.addEventListener("visibilitychange", syncVisibility);
  globalThis.addEventListener?.("pageshow", syncVisibility);
  const stopNative = nativeVisibility?.((visible) => {
    nativeVisible = visible;
    syncVisibility();
  });
  syncVisibility();
  return () => {
    doc.removeEventListener("visibilitychange", syncVisibility);
    globalThis.removeEventListener?.("pageshow", syncVisibility);
    stopNative?.();
  };
}
