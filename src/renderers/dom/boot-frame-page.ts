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
/** A frame's markup larger than this is not kept or drawn; a layout's chrome is a few dozen kilobytes. */
export const MAX_BOOT_FRAME_CHARS = 600_000;
/** The root and body styles: the theme's colours and the text metrics, a few kilobytes. */
const MAX_BOOT_FRAME_STYLE_CHARS = 20_000;
const MAX_BOOT_FRAME_BUILD_CHARS = 200;

function isPositiveSize(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** A stored frame of the right shape and within the size limits. Anything else is not saved or drawn. */
export function isBootFrame(value: unknown): value is BootFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  return typeof frame.build === "string" && frame.build.length <= MAX_BOOT_FRAME_BUILD_CHARS
    && isPositiveSize(frame.width)
    && isPositiveSize(frame.height)
    && typeof frame.rootStyle === "string" && frame.rootStyle.length <= MAX_BOOT_FRAME_STYLE_CHARS
    && typeof frame.bodyStyle === "string" && frame.bodyStyle.length <= MAX_BOOT_FRAME_STYLE_CHARS
    && typeof frame.html === "string" && frame.html.length <= MAX_BOOT_FRAME_CHARS;
}

/**
 * Strips a frame's markup, in `container` and the container itself, of
 * everything that could load, run, navigate, take focus or be found as the
 * app's own: elements that load or run, event handlers, links and sources,
 * form targets, styles that fetch, ids and names. The recorder runs it on the
 * copy it stores, and the page again on the copy it reads back, which is only
 * as trustworthy as the file or storage it was kept in.
 *
 * The page's inline script carries this function's source, so it is plain
 * JavaScript that reads nothing outside itself.
 */
export function scrubBootFrame(container: ParentNode): void {
  const droppedElements = [
    "script", "noscript", "style", "link", "meta", "base", "title", "template", "slot",
    "iframe", "frame", "frameset", "object", "embed", "applet", "param", "portal", "fencedframe",
    "img", "image", "picture", "source", "track", "video", "audio", "canvas", "math",
    "foreignobject", "use", "feimage", "animate", "animatemotion", "animatetransform", "animatecolor",
    "set", "discard", "mpath", "handler", "listener",
  ];
  const droppedAttributes = [
    "src", "srcset", "srcdoc", "action", "formaction", "poster", "background", "ping", "lowsrc",
    "dynsrc", "data", "codebase", "classid", "archive", "longdesc", "usemap", "manifest", "is",
    "id", "name", "tabindex", "autofocus", "contenteditable", "value",
    "data-gloom-pane-id", "data-gloom-remote-node-id",
  ];
  // A style that could fetch: url(), image() and image-set() take addresses,
  // and an escape could spell either past this check.
  const fetchingStyle = /url\s*\(|image(-set)?\s*\(|\\|@import|expression\s*\(/i;
  const scriptAddress = /^\s*(javascript|vbscript|data)\s*:/i;
  const scrubElement = (element: Element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (
        name.startsWith("on")
        || name.endsWith("href")
        || droppedAttributes.includes(name)
        || /url\s*\(/i.test(value)
        || scriptAddress.test(value)
        || (name === "style" && fetchingStyle.test(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  };
  const self = container as unknown as Element;
  if (self.nodeType === 1) scrubElement(self);
  for (const element of Array.from(container.querySelectorAll("*"))) {
    if (droppedElements.includes(element.localName.toLowerCase())) element.remove();
    else scrubElement(element);
  }
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
 * A stored frame from this build for this window size is drawn as it was,
 * after the page scrubs it again. Otherwise the page draws the bare shell:
 * the header and status bar, empty, in the stored frame's theme and text
 * size when there is one, else the default theme's.
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
  var maxStyle = ${MAX_BOOT_FRAME_STYLE_CHARS};
  if (!frame || typeof frame !== "object" || typeof frame.html !== "string" || frame.html.length > ${MAX_BOOT_FRAME_CHARS}
    || typeof frame.rootStyle !== "string" || frame.rootStyle.length > maxStyle
    || typeof frame.bodyStyle !== "string" || frame.bodyStyle.length > maxStyle) frame = null;
  var scrub = ${scrubBootFrame.toString()};
  // Parsed in a template, whose content is inert: nothing in it loads or runs before the scrub.
  var template = document.createElement("template");
  var safeStyle = function (style) {
    var holder = template.content.ownerDocument.createElement("div");
    holder.setAttribute("style", style);
    scrub(holder);
    return holder.getAttribute("style") || "";
  };
  var overlay = document.createElement("div");
  overlay.id = ${scriptJson(BOOT_FRAME_ELEMENT_ID)};
  // A picture of the app: nothing in it takes focus, a click or a screen reader.
  overlay.setAttribute("inert", "");
  overlay.setAttribute("aria-hidden", "true");
  var rootStyle = frame ? safeStyle(frame.rootStyle) : "";
  var bodyStyle = frame ? safeStyle(frame.bodyStyle) : "";
  if (frame && frame.build === ${scriptJson(build)}
    && Math.abs(frame.width - window.innerWidth) <= 1 && Math.abs(frame.height - window.innerHeight) <= 1) {
    if (rootStyle) document.documentElement.setAttribute("style", rootStyle);
    if (bodyStyle) document.body.setAttribute("style", bodyStyle);
    overlay.setAttribute("data-gloom-boot-frame", "layout");
    template.innerHTML = frame.html;
    scrub(template.content);
    overlay.appendChild(template.content);
  } else {
    // The default theme first, so a stored theme that names fewer colours still leaves every one set.
    var shellStyle = ${scriptJson(shellStyle)};
    var themeStyle = [shellStyle, rootStyle].join(" ").trim();
    if (themeStyle && !document.documentElement.getAttribute("style")) document.documentElement.setAttribute("style", themeStyle);
    if (bodyStyle) document.body.setAttribute("style", bodyStyle);
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
