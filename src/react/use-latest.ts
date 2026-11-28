import { useRef, type MutableRefObject } from "react";

/** Keeps a ref pointed at the latest render value so stable callbacks never read stale state. */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
