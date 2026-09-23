import { useEffect, useReducer, useRef } from "react";

function sameDeps(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

interface ThrottledMemoState<T> {
  value: T;
  throttledDeps: readonly unknown[];
  immediateDeps: readonly unknown[];
  at: number;
}

/**
 * useMemo whose recomputation for `throttledDeps` (quote-driven inputs) runs at
 * most once per interval, during a render that is happening anyway. A change
 * to `immediateDeps` (collection, currency, rates) recomputes at once. When the
 * input stops changing inside the interval, one trailing render catches up.
 */
export function useThrottledMemo<T>(
  compute: () => T,
  throttledDeps: readonly unknown[],
  immediateDeps: readonly unknown[],
  intervalMs: number,
): T {
  const stateRef = useRef<ThrottledMemoState<T> | null>(null);
  const latestThrottledDepsRef = useRef(throttledDeps);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, forceRender] = useReducer((count: number) => count + 1, 0);
  latestThrottledDepsRef.current = throttledDeps;

  const state = stateRef.current;
  const now = Date.now();
  let pending = false;
  if (!state || !sameDeps(state.immediateDeps, immediateDeps) || now - state.at >= intervalMs) {
    if (!state || !sameDeps(state.immediateDeps, immediateDeps) || !sameDeps(state.throttledDeps, throttledDeps)) {
      stateRef.current = { value: compute(), throttledDeps, immediateDeps, at: now };
    }
  } else if (!sameDeps(state.throttledDeps, throttledDeps)) {
    pending = true;
  }

  useEffect(() => {
    if (!pending || timerRef.current) return;
    const wait = Math.max(0, intervalMs - (Date.now() - (stateRef.current?.at ?? 0)));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const current = stateRef.current;
      if (current && !sameDeps(current.throttledDeps, latestThrottledDepsRef.current)) forceRender();
    }, wait);
  });

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return stateRef.current!.value;
}
