import { useEffect, useRef } from "react";
import { useDataFrameWake } from "../../../market-data/frame-wake";

function sameDeps(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

interface ThrottledMemoState<T> {
  value: T;
  throttledDeps: readonly unknown[];
  immediateDeps: readonly unknown[];
  /** When it last recomputed, on the market data clock (monotonic, so a wall-clock step cannot stall it). */
  at: number;
}

/**
 * useMemo whose recomputation for `throttledDeps` (quote-driven inputs) runs at
 * most once per interval, during a render that is happening anyway. A change
 * to `immediateDeps` (collection, currency, rates) recomputes at once. When the
 * input stops changing inside the interval, one trailing render catches up, in
 * a market data frame, so it shares a commit with the quotes that frame brings.
 */
export function useThrottledMemo<T>(
  compute: () => T,
  throttledDeps: readonly unknown[],
  immediateDeps: readonly unknown[],
  intervalMs: number,
): T {
  const stateRef = useRef<ThrottledMemoState<T> | null>(null);
  const clock = useDataFrameWake();

  const state = stateRef.current;
  const now = clock.now();
  let pending = false;
  if (!state || !sameDeps(state.immediateDeps, immediateDeps) || now - state.at >= intervalMs) {
    if (!state || !sameDeps(state.immediateDeps, immediateDeps) || !sameDeps(state.throttledDeps, throttledDeps)) {
      stateRef.current = { value: compute(), throttledDeps, immediateDeps, at: now };
    }
  } else if (!sameDeps(state.throttledDeps, throttledDeps)) {
    pending = true;
  }

  useEffect(() => {
    // A render that caught up in the meantime (an input changed) drops the trailing one.
    if (pending) clock.wakeAt(stateRef.current!.at + intervalMs);
    else clock.cancel();
  });

  return stateRef.current!.value;
}
