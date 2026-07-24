/// <reference lib="dom" />

type KeyboardTargetLike = EventTarget & {
  tagName?: string;
  nodeName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
  getAttribute?: (name: string) => string | null;
};

type WebKeyDefaultEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "target"> & {
  altKey?: boolean;
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

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const element = getKeyboardTarget(target);
  if (!element) return false;

  const tagName = getTargetTagName(element);
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
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
  if (tagName === "BUTTON" || tagName === "SUMMARY") return true;
  if (tagName === "A" && element.getAttribute?.("href") != null) return true;

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

export function shouldDispatchWebAppKeyDown(event: WebKeyDefaultEvent): boolean {
  if (isNativeKeyboardControlTarget(event.target) && isNativeControlActivationKey(event)) return false;
  return normalizeWebKeyName(event.key) !== "tab"
    || !!event.ctrlKey
    || !!event.metaKey
    || !!event.altKey;
}

export function shouldDispatchWebNativeKeyDown(event: WebKeyDefaultEvent): boolean {
  return !isEditableKeyboardTarget(event.target) && shouldDispatchWebAppKeyDown(event);
}

export function shouldConsumeWebAppKeyDown(event: WebKeyDefaultEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (!shouldDispatchWebAppKeyDown(event)) return false;
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
