import type { NativeFrameCapture } from "../ui/host";
import { captureAppScreenshotJpegBase64 } from "../utils/dom-screenshot";
import {
  FEEDBACK_FRAME_MAX_COLS,
  FEEDBACK_FRAME_MAX_ROWS,
  FEEDBACK_IMAGE_BASE64_MAX,
  type FeedbackScreenshot,
  type TerminalFrameSpan,
} from "./types";

function hex(channel: number): string {
  return Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0");
}

function rgbaHex([r, g, b, a]: readonly [number, number, number, number]): string {
  const rgb = `#${hex(r)}${hex(g)}${hex(b)}`;
  return a >= 255 ? rgb : `${rgb}${hex(a)}`;
}

/**
 * A terminal frame as the report's "screenshot": styled text the admin page
 * redraws in a browser. Terminals have no pixels to hand over, and a
 * text frame is a few KB where an image would be hundreds.
 */
export function terminalFrameScreenshot(frame: NativeFrameCapture): FeedbackScreenshot {
  const rows = Math.min(frame.rows, FEEDBACK_FRAME_MAX_ROWS);
  const lines = frame.lines.slice(0, rows).map((spans) => spans.map((span): TerminalFrameSpan => {
    const out: TerminalFrameSpan = { t: span.text, fg: rgbaHex(span.fg), bg: rgbaHex(span.bg) };
    if (span.attributes) out.a = span.attributes & 0xff;
    return out;
  }));
  return { kind: "terminal", cols: Math.min(Math.max(1, frame.cols), FEEDBACK_FRAME_MAX_COLS), rows: Math.max(1, rows), lines };
}

/** Where the dialog host draws, so the app shot shows the screen behind the dialog. */
const DIALOG_LAYER_SELECTOR = ".gloom-dialog-backdrop";

export async function captureAppImageScreenshot(): Promise<FeedbackScreenshot> {
  // Headroom under the server cap for the rest of the JSON body.
  const shot = await captureAppScreenshotJpegBase64({
    maxBase64Length: FEEDBACK_IMAGE_BASE64_MAX - 20_000,
    skipSelector: DIALOG_LAYER_SELECTOR,
  });
  return { kind: "image", mimeType: "image/jpeg", data: shot.jpegBase64 };
}
