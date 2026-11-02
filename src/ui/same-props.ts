import { isValidElement } from "react";

/**
 * Memoized components that render from their props and context alone, such
 * as the kit's Box and Text: two elements of one with equal props render the
 * same thing.
 */
const pureTypes = new WeakSet<object>();

/** Marks a memoized component as rendering from its props and context alone. */
export function markPure<T extends object>(type: T): T {
  pureTypes.add(type);
  return type;
}

/** How many elements and arrays deep a comparison looks before calling props different. */
const MAX_DEPTH = 6;

function sameValue(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right)) return true;
  if (depth >= MAX_DEPTH || typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameValue(left[index], right[index], depth + 1)) return false;
    }
    return true;
  }
  if (!isValidElement(left) || !isValidElement(right)) return false;
  // Any other component may read more than its props while it renders, so
  // only a pure component's element counts as the same for equal props.
  return left.type === right.type
    && left.key === right.key
    && typeof left.type === "object"
    && pureTypes.has(left.type)
    && sameProps(left.props as Record<string, unknown>, right.props as Record<string, unknown>, depth + 1);
}

/**
 * The memo test for a pure component: props are the same when each is equal,
 * where elements of pure components (a Box of Texts) compare by their props
 * instead of by identity, as a parent builds them afresh on each render.
 * Functions and other objects still compare by identity.
 */
export function samePureProps<P extends object>(left: Readonly<P>, right: Readonly<P>): boolean {
  return sameProps(left as Record<string, unknown>, right as Record<string, unknown>, 0);
}

function sameProps(left: Record<string, unknown>, right: Record<string, unknown>, depth: number): boolean {
  if (left === right) return true;
  let count = 0;
  for (const key in left) {
    count += 1;
    if (!Object.prototype.hasOwnProperty.call(right, key) || !sameValue(left[key], right[key], depth)) return false;
  }
  for (const _key in right) count -= 1;
  return count === 0;
}
