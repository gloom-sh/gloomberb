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

export function useThrottledTickerOrder(
  candidateSymbols: string[],
  resetKey: string,
  throttleMs = PORTFOLIO_REORDER_THROTTLE_MS,
): string[] {
  const [committedSymbols, setCommittedSymbols] = useState(candidateSymbols);
  const committedRef = useRef(candidateSymbols);
  const latestCandidateRef = useRef(candidateSymbols);
  const resetKeyRef = useRef(resetKey);
  const lastCommitAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const candidateKey = JSON.stringify(candidateSymbols);

  useEffect(() => {
    latestCandidateRef.current = candidateSymbols;
    const current = committedRef.current;
    const resetChanged = resetKeyRef.current !== resetKey;
    const membershipChanged = !hasSameMembership(current, candidateSymbols);
    resetKeyRef.current = resetKey;

    const commit = (nextSymbols: string[]) => {
      committedRef.current = nextSymbols;
      lastCommitAtRef.current = Date.now();
      setCommittedSymbols(nextSymbols);
    };

    if (resetChanged || membershipChanged) {
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
  }, [candidateKey, resetKey, throttleMs]);

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
