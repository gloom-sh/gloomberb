import { useEffect, useMemo, useRef, useState } from "react";

export const PORTFOLIO_REORDER_THROTTLE_MS = 5_000;

function hasSameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((symbol, index) => symbol === right[index]);
}

function hasSameMembership(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const symbols = new Set(left);
  return right.every((symbol) => symbols.has(symbol));
}

function hasUnseenSymbol(symbols: ReadonlySet<string> | undefined, seen: ReadonlySet<string>): boolean {
  if (!symbols) return false;
  for (const symbol of symbols) {
    if (!seen.has(symbol)) return true;
  }
  return false;
}

/**
 * The order a table shows while quotes move it. A user's sort change, a row
 * joining or leaving, and a row getting its first figure in the sort column
 * (the list's values arriving after its rows) all apply at once. Rows that
 * already had a figure only reshuffle among themselves once per `throttleMs`,
 * so live ticks do not make the list jump. `valuedSymbols` are the rows that
 * have a figure now; leave it out for an order that has no such arrival.
 */
export function useThrottledTickerOrder(
  candidateSymbols: string[],
  resetKey: string,
  { throttleMs = PORTFOLIO_REORDER_THROTTLE_MS, valuedSymbols }: {
    throttleMs?: number;
    valuedSymbols?: ReadonlySet<string>;
  } = {},
): string[] {
  const [committedSymbols, setCommittedSymbols] = useState(candidateSymbols);
  const committedRef = useRef(candidateSymbols);
  const latestCandidateRef = useRef(candidateSymbols);
  const resetKeyRef = useRef(resetKey);
  // Rows that have had a figure since the last sort or list change: a row that
  // loses it and gets it back is a live flicker, not an arrival.
  const valuedRef = useRef<Set<string> | null>(null);
  if (valuedRef.current === null) valuedRef.current = new Set(valuedSymbols);
  const lastCommitAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const candidateKey = JSON.stringify(candidateSymbols);
  // Whether a row has a figure it has not had before: a quote tick that only
  // moves the rows' values does not wake the effect.
  const hasNewValue = hasUnseenSymbol(valuedSymbols, valuedRef.current);

  useEffect(() => {
    latestCandidateRef.current = candidateSymbols;
    const current = committedRef.current;
    const resetChanged = resetKeyRef.current !== resetKey;
    const membershipChanged = !hasSameMembership(current, candidateSymbols);
    resetKeyRef.current = resetKey;

    const valued = valuedRef.current!;
    let firstValue = false;
    if (resetChanged) valued.clear();
    if (valuedSymbols) {
      for (const symbol of valuedSymbols) {
        if (valued.has(symbol)) continue;
        valued.add(symbol);
        firstValue = true;
      }
    }

    const commit = (nextSymbols: string[]) => {
      committedRef.current = nextSymbols;
      lastCommitAtRef.current = Date.now();
      setCommittedSymbols(nextSymbols);
    };

    if (resetChanged || membershipChanged || firstValue) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      if (!hasSameOrder(current, candidateSymbols)) commit(candidateSymbols);
      return;
    }
    if (hasSameOrder(current, candidateSymbols)) return;

    const elapsed = Date.now() - lastCommitAtRef.current;
    const remaining = Math.max(0, throttleMs - elapsed);
    if (remaining === 0) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      commit(candidateSymbols);
      return;
    }
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const latest = latestCandidateRef.current;
      if (!hasSameOrder(committedRef.current, latest)) commit(latest);
    }, remaining);
  }, [candidateKey, resetKey, throttleMs, hasNewValue]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return useMemo(() => {
    const currentSymbols = new Set(candidateSymbols);
    const ordered = committedSymbols.filter((symbol) => currentSymbols.has(symbol));
    const orderedSet = new Set(ordered);
    for (const symbol of candidateSymbols) {
      if (!orderedSet.has(symbol)) ordered.push(symbol);
    }
    return ordered;
  }, [candidateKey, committedSymbols]);
}
