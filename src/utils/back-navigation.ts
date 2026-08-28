export interface BackNavigationEventLike {
  name?: string;
  key?: string;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  shift?: boolean;
}

export interface BackNavigationMouseEventLike {
  button?: unknown;
}

export const MOUSE_BACK_NAVIGATION_EVENT_NAME = "mouse-back";
const WEB_MOUSE_BACK_NAVIGATION_BUTTON = 3;
const TERMINAL_MOUSE_BACK_NAVIGATION_BUTTON = 8;

export function isPlainBackspace(event: BackNavigationEventLike): boolean {
  return event.name === "backspace"
    && !event.ctrl
    && !event.meta
    && !event.option
    && !event.shift;
}

export function isPlainEscape(event: BackNavigationEventLike): boolean {
  return (event.name === "escape" || event.name === "esc")
    && !event.ctrl
    && !event.meta
    && !event.option
    && !event.shift;
}

export function isDetailBackNavigationKey(
  event: BackNavigationEventLike,
): boolean {
  return isPlainBackspace(event)
    || isPlainEscape(event)
    || event.name === MOUSE_BACK_NAVIGATION_EVENT_NAME
    || event.key === MOUSE_BACK_NAVIGATION_EVENT_NAME;
}

export function isMouseBackNavigationButton(button: unknown): boolean {
  return button === WEB_MOUSE_BACK_NAVIGATION_BUTTON
    || button === TERMINAL_MOUSE_BACK_NAVIGATION_BUTTON;
}

export function isMouseBackNavigationEvent(
  event: BackNavigationMouseEventLike | null | undefined,
): boolean {
  return isMouseBackNavigationButton(event?.button);
}
