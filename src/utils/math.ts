export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * An index kept inside a list of `length` items. An empty list has no valid
 * index, so it returns `empty`: 0 by default, or -1 where callers need to tell
 * "nothing selected" apart from the first row.
 */
export function clampIndex(index: number, length: number, empty = 0): number {
  return length <= 0 ? empty : clamp(index, 0, length - 1);
}
