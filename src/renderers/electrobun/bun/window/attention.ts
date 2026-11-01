import { setStallAttentionProbe, type StallAttention } from "../../../../telemetry/stall-reports";

/** What this needs of a window: its id, its minimized state and its events. */
interface AttentionWindow {
  id: number;
  isMinimized(): boolean;
  on?(name: string, handler: (event: unknown) => void): void;
}

const openWindows = new Map<number, AttentionWindow>();
let focusedWindowId: number | null = null;
let sawFocusChange = false;

/**
 * Whether anyone was looking when the desktop app's Bun process froze. The
 * system slows a hidden app's timers, which reads like a freeze, so a stall
 * report from this process says whether one of the app's windows had the
 * keyboard (the app was in front) and whether one was open and not
 * minimized. Read only for a stall about to be reported.
 */
function desktopAttention(): StallAttention {
  let visible: boolean | null = false;
  try {
    for (const window of openWindows.values()) {
      if (!window.isMinimized()) {
        visible = true;
        break;
      }
    }
  } catch {
    visible = null;
  }
  return { active: sawFocusChange ? focusedWindowId !== null : null, visible };
}

/** Follows a window the app opened until it closes; the first one installs the probe. */
export function trackWindowAttention(window: AttentionWindow): void {
  if (openWindows.size === 0) setStallAttentionProbe(desktopAttention);
  openWindows.set(window.id, window);
  window.on?.("focus", () => {
    focusedWindowId = window.id;
    sawFocusChange = true;
  });
  window.on?.("blur", () => {
    // Focus moving between two of the app's windows can report the new
    // window's focus before the old one's blur.
    if (focusedWindowId === window.id) focusedWindowId = null;
    sawFocusChange = true;
  });
  window.on?.("close", () => {
    openWindows.delete(window.id);
    if (focusedWindowId === window.id) focusedWindowId = null;
  });
}
