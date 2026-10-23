/**
 * The launch frame's format and the inline script that draws it, for the
 * page builds and the desktop Bun process; the DOM side that records it is
 * boot-frame.ts.
 */

export interface BootFrame {
  /** The build that drew it; markup only matches the stylesheet it was drawn with. */
  build: string;
  width: number;
  height: number;
  /** The root element's inline style: the theme's colours. */
  rootStyle: string;
  /** The body's inline style: cell metrics and text size. */
  bodyStyle: string;
  html: string;
}

/** The element the page draws the frame in, over the app's root. */
export const BOOT_FRAME_ELEMENT_ID = "gloom-boot-frame";
/** Marks a copied box that was scrolled, as `top,left`, for the page to scroll it the same. */
export const BOOT_FRAME_SCROLL_ATTRIBUTE = "data-gloom-boot-scroll";
/** The page's build, which the inline script sets for the recorder to stamp frames with. */
export const BOOT_FRAME_BUILD_GLOBAL = "__gloomBootFrameBuild";

export function isBootFrame(value: unknown): value is BootFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  return typeof frame.build === "string"
    && typeof frame.width === "number"
    && typeof frame.height === "number"
    && typeof frame.rootStyle === "string"
    && typeof frame.bodyStyle === "string"
    && typeof frame.html === "string";
}

/**
 * Names the build a page comes from, from its script and stylesheet: a frame
 * drawn by another build may not match the stylesheet it would be drawn with.
 */
export function bootFrameBuildId(script: string | Uint8Array, stylesheet: string): string {
  return `${Bun.hash(script).toString(36)}-${Bun.hash(stylesheet).toString(36)}`;
}

/** A JSON value safe inside an inline script. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

interface BootFrameScriptOptions {
  build: string;
  /** A JavaScript expression for the stored frame, evaluated inside a try. */
  source: string;
  /** A JavaScript expression that is true on a page that draws no frame, such as a window holding one popped-out pane. */
  skip?: string;
  /** The default theme's root style, for the bare shell drawn when there is no frame to redraw. */
  shellStyle?: string;
}

/**
 * The inline script that draws the frame, placed right after the app's root.
 * With no frame from this build for this window size it draws the bare shell
 * instead: the header and status bar, empty, in the default theme's colours.
 */
export function bootFrameScript({ build, source, skip = "false", shellStyle = "" }: BootFrameScriptOptions): string {
  return `(function () {
  window.${BOOT_FRAME_BUILD_GLOBAL} = ${scriptJson(build)};
  var root = document.getElementById("root");
  var skip = false;
  try { skip = !!(${skip}); } catch (error) { skip = false; }
  if (!root || skip) return;
  var frame = null;
  try { frame = ${source}; } catch (error) { frame = null; }
  var overlay = document.createElement("div");
  overlay.id = ${scriptJson(BOOT_FRAME_ELEMENT_ID)};
  overlay.setAttribute("aria-hidden", "true");
  if (frame && frame.build === ${scriptJson(build)} && typeof frame.html === "string"
    && Math.abs(frame.width - window.innerWidth) <= 1 && Math.abs(frame.height - window.innerHeight) <= 1) {
    if (frame.rootStyle) document.documentElement.setAttribute("style", frame.rootStyle);
    if (frame.bodyStyle) document.body.setAttribute("style", frame.bodyStyle);
    overlay.setAttribute("data-gloom-boot-frame", "layout");
    overlay.innerHTML = frame.html;
  } else {
    var shellStyle = ${scriptJson(shellStyle)};
    if (shellStyle && !document.documentElement.getAttribute("style")) document.documentElement.setAttribute("style", shellStyle);
    overlay.setAttribute("data-gloom-boot-frame", "shell");
    overlay.innerHTML = '<div class="gloom-boot-header"></div><div class="gloom-boot-status"></div>';
  }
  root.parentNode.insertBefore(overlay, root.nextSibling);
  var scrolled = overlay.querySelectorAll("[${BOOT_FRAME_SCROLL_ATTRIBUTE}]");
  for (var index = 0; index < scrolled.length; index += 1) {
    var offset = scrolled[index].getAttribute("${BOOT_FRAME_SCROLL_ATTRIBUTE}").split(",");
    scrolled[index].scrollTop = Number(offset[0]) || 0;
    scrolled[index].scrollLeft = Number(offset[1]) || 0;
  }
})();`;
}
