
type KeyboardTargetLike = EventTarget & {
  tagName?: string;
  nodeName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
  getAttribute?: (name: string) => string | null;
};

type WebKeyDefaultEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "target"> & {
  defaultPrevented?: boolean;
  isComposing?: boolean;
};

function controlLetterForKey(key: string): string | null {
  if (key.length !== 1) return null;
  const code = key.charCodeAt(0);
  if (code < 1 || code > 26) return null;
  return String.fromCharCode(96 + code);
}

function getKeyboardTarget(target: EventTarget | null): KeyboardTargetLike | null {
  if (!target || typeof target !== "object") return null;
  return target as KeyboardTargetLike;
}

function getTargetTagName(target: KeyboardTargetLike): string {
  return (target.tagName ?? target.nodeName ?? "").toUpperCase();
}

function targetHasClosest(target: KeyboardTargetLike, selector: string): boolean {
  if (typeof target.closest !== "function") return false;
  try {
    return target.closest(selector) != null;
  } catch {
    return false;
  }
}

/** Inputs that take no typing: a checkbox or a slider holding focus must not swallow pane keys. */
const NON_TEXT_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const element = getKeyboardTarget(target);
  if (!element) return false;

  const tagName = getTargetTagName(element);
  if (tagName === "INPUT") {
    return !NON_TEXT_INPUT_TYPES.has((element.getAttribute?.("type") ?? "text").toLowerCase());
  }
  if (tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  if (element.isContentEditable === true) return true;

  const contentEditable = element.getAttribute?.("contenteditable");
  return contentEditable === "" || contentEditable?.toLowerCase() === "true"
    || targetHasClosest(element, "input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

function isNativeKeyboardControlTarget(target: EventTarget | null): boolean {
  const element = getKeyboardTarget(target);
  if (!element) return false;

  const tagName = getTargetTagName(element);
  if (tagName === "BUTTON" || tagName === "A" || tagName === "SUMMARY") return true;

  return targetHasClosest(element, "button, a[href], summary");
}

function isBrowserModifierShortcut(event: WebKeyDefaultEvent): boolean {
  if (event.metaKey) return true;
  if (!event.ctrlKey || event.shiftKey) return false;

  const key = normalizeWebKeyName(event.key);
  return key === "c" || key === "v" || key === "x" || key === "a";
}

function isNativeControlActivationKey(event: WebKeyDefaultEvent): boolean {
  const key = normalizeWebKeyName(event.key);
  return key === "return" || key === "enter" || key === "space";
}

export function shouldConsumeWebAppKeyDown(event: WebKeyDefaultEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (isEditableKeyboardTarget(event.target)) return false;
  if (isBrowserModifierShortcut(event)) return false;
  if (isNativeKeyboardControlTarget(event.target) && isNativeControlActivationKey(event)) return false;
  return true;
}

export function normalizeWebKeyName(key: string): string {
  const controlLetter = controlLetterForKey(key);
  if (controlLetter) return controlLetter;

  switch (key) {
    case " ":
      return "space";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "Enter":
      return "return";
    case "Escape":
      return "escape";
    case "Backspace":
      return "backspace";
    case "Delete":
      return "delete";
    case "Tab":
      return "tab";
    default:
      return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  }
}

export function hasWebCtrlModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || controlLetterForKey(event.key) !== null;
}

export function webKeySequence(event: KeyboardEvent): string {
  switch (event.key) {
    case "Enter":
      return "\r";
    case "Escape":
      return "\x1b";
    case "Tab":
      return "\t";
    case "Backspace":
      return "\x7f";
    default:
      return event.key;
  }
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(", ");

interface FocusTrapDocument {
  activeElement: Element | null;
  querySelectorAll(selector: string): ArrayLike<Element>;
}

function isShownFocusable(element: Element): boolean {
  const html = element as HTMLElement;
  if (html.getAttribute?.("aria-hidden") === "true") return false;
  return typeof html.getClientRects !== "function" || html.getClientRects().length > 0;
}

/**
 * Tab and Shift+Tab walk the controls of the open dialog and wrap inside it,
 * the way every modal on the platform does. The app claims Tab for pane focus
 * everywhere else, so a dialog that handles Tab itself (a form ring) keeps it:
 * this only runs for a Tab no handler took.
 */
export function moveDialogFocus(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "defaultPrevented">,
  doc: FocusTrapDocument | undefined = (globalThis as { document?: FocusTrapDocument }).document,
): boolean {
  if (event.key !== "Tab" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !doc) return false;
  const dialogs = doc.querySelectorAll(".gloom-dialog");
  const dialog = dialogs[dialogs.length - 1] as (Element & { focus?: (options?: FocusOptions) => void }) | undefined;
  if (!dialog) return false;
  const focusables = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isShownFocusable) as HTMLElement[];
  if (focusables.length === 0) return true;
  const current = focusables.indexOf(doc.activeElement as HTMLElement);
  const next = current < 0
    ? (event.shiftKey ? focusables.length - 1 : 0)
    : (current + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
  focusables[next]!.focus({ preventScroll: false });
  return true;
}
