import { setWindowFullscreen } from "../../../components/layout/window-fullscreen";
import { backendRequest } from "./backend-rpc";

/**
 * Long enough that dragging a window edge does not ask the host on every
 * frame, short enough that the header has moved by the time the fullscreen
 * animation finishes.
 */
const RESIZE_SETTLE_MS = 120;

/**
 * Keeps the view's idea of its window's fullscreen state current. Electrobun
 * emits no fullscreen event and a webview cannot see its window's style mask,
 * but entering and leaving fullscreen always resizes the window, so the host
 * is asked every time the size settles.
 */
export function installElectrobunWindowFullscreenTracking(): () => void {
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let reading = false;
  let readAgain = false;

  const read = async (): Promise<void> => {
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    try {
      setWindowFullscreen(await backendRequest("host.windowFullscreen") === true);
    } catch {
      // A host too old to answer has the window chrome the header already
      // assumes, so leaving the last known state alone is the safe read.
    } finally {
      reading = false;
      if (readAgain) {
        readAgain = false;
        void read();
      }
    }
  };

  const scheduleRead = (): void => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      void read();
    }, RESIZE_SETTLE_MS);
  };

  window.addEventListener("resize", scheduleRead);
  void read();

  return () => {
    window.removeEventListener("resize", scheduleRead);
    if (settleTimer) clearTimeout(settleTimer);
  };
}
