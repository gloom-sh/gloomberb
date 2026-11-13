export interface KeyboardModifierEventLike {
  ctrl?: boolean;
  meta?: boolean;
  super?: boolean;
  alt?: boolean;
  option?: boolean;
  shift?: boolean;
  name?: string;
}

function hasKeyboardModifier(event: KeyboardModifierEventLike): boolean {
  return !!(
    event.ctrl
    || event.meta
    || event.super
    || event.alt
    || event.option
    || event.shift
  );
}

export function isPlainKeyboardEvent(event: KeyboardModifierEventLike): boolean {
  return !hasKeyboardModifier(event);
}

/** A key that types a character, which a filter box takes rather than the list under it. */
export function isTextKey(event: { sequence?: string; ctrl?: boolean; meta?: boolean; alt?: boolean }): boolean {
  return event.sequence?.length === 1 && event.sequence >= " " && event.sequence !== "\u007f"
    && !event.ctrl && !event.meta && !event.alt;
}

export function isPlainKey(
  event: KeyboardModifierEventLike,
  ...names: string[]
): boolean {
  return isPlainKeyboardEvent(event) && names.includes(event.name ?? "");
}
