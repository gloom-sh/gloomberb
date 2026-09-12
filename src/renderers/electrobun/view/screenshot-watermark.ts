/// <reference lib="dom" />

import { setScreenshotWatermarkVisible } from "../../../utils/screenshot-watermark";

/**
 * How long the watermark stays after the last screenshot signal. Cmd+Shift+4
 * still needs a region drag and Cmd+Shift+5 shows a toolbar first; both
 * happen in a system overlay the page never hears about, so time is the only
 * cue left. A mistaken chord costs a few seconds of faint wordmark, nothing
 * more.
 */
export const SCREENSHOT_WATERMARK_LINGER_MS = 6_000;

export type ScreenshotKeySignal = "show" | "hide" | "keep";

type ScreenshotKeyEventLike = Pick<KeyboardEvent, "key" | "metaKey" | "shiftKey">;

const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Fn", "Hyper", "Meta", "OS", "Shift", "Super"]);

/**
 * Classify a keydown. The OS swallows the final key of its screenshot chords
 * (Cmd+Shift+3/4/5 on macOS, Win+Shift+S on Windows), so the modifier prefix
 * is the only part the page ever sees; that prefix reveals the watermark. Any
 * complete chord that does reach the page is an app shortcut, not a
 * screenshot, and hides it again. Print Screen is delivered on Windows and on
 * desktops that do not grab it globally, so it counts as a screenshot outright.
 */
export function screenshotKeySignal(event: ScreenshotKeyEventLike): ScreenshotKeySignal {
  if (event.key === "PrintScreen" || event.key === "Snapshot") return "show";
  if (MODIFIER_KEYS.has(event.key)) {
    return event.metaKey && event.shiftKey ? "show" : "keep";
  }
  return "hide";
}

export function installScreenshotWatermark(target: Window = window): () => void {
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;

  const hide = () => {
    if (lingerTimer !== null) {
      clearTimeout(lingerTimer);
      lingerTimer = null;
    }
    setScreenshotWatermarkVisible(false);
  };

  const show = () => {
    if (lingerTimer !== null) clearTimeout(lingerTimer);
    setScreenshotWatermarkVisible(true);
    lingerTimer = setTimeout(hide, SCREENSHOT_WATERMARK_LINGER_MS);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const signal = screenshotKeySignal(event);
    if (signal === "show") show();
    else if (signal === "hide") hide();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    // Print Screen on Windows often only surfaces as keyup.
    if (screenshotKeySignal(event) === "show" && !MODIFIER_KEYS.has(event.key)) show();
  };
  // Pointer input means the user is back in the app; system capture overlays
  // keep their own mouse events.
  const onPointer = () => hide();

  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("keyup", onKeyUp, true);
  target.addEventListener("mousedown", onPointer, true);
  target.addEventListener("wheel", onPointer, { capture: true, passive: true });
  return () => {
    hide();
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("keyup", onKeyUp, true);
    target.removeEventListener("mousedown", onPointer, true);
    target.removeEventListener("wheel", onPointer, { capture: true } as EventListenerOptions);
  };
}
