import type { ForwardedRef, Ref } from "react";

/** Hands a node to a callback or object ref, for components that also keep their own. */
export function assignRef<T>(ref: Ref<T> | ForwardedRef<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    (ref as { current: T | null }).current = value;
  }
}
