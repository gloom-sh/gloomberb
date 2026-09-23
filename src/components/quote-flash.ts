import { useEffect, useRef, useState } from "react";
import type { TickerFinancials } from "../types/financials";
import { getActiveQuoteDisplay } from "../market-data/market/status";

export type QuoteFlashDirection = "up" | "down" | "flat";

/** How long a changed price stays flashed. */
export const FLASH_DURATION_MS = 300;
/**
 * Quiet time after a flash before the same symbol may flash again. Streamed
 * prices can change several times a second; without a gap a busy symbol would
 * stay dimmed and its price would be harder to read than a quiet one's.
 */
export const FLASH_GAP_MS = 300;

function resolveFlashPrice(financials: TickerFinancials | null | undefined): number | null {
  return getActiveQuoteDisplay(financials?.quote)?.price ?? financials?.quote?.price ?? null;
}

function resolveFlashDirection(previousPrice: number, nextPrice: number): QuoteFlashDirection {
  if (nextPrice > previousPrice) return "up";
  if (nextPrice < previousPrice) return "down";
  return "flat";
}

interface FlashState {
  direction: QuoteFlashDirection;
  /** When the flash ends. */
  until: number;
  /** When the symbol may flash again. */
  nextAllowedAt: number;
}

/**
 * Per-symbol flash bookkeeping. Each symbol flashes on its own clock, so one
 * symbol's tick never cuts another symbol's flash short.
 */
export class QuoteFlashTracker {
  private readonly previousPrices = new Map<string, number>();
  private readonly flashes = new Map<string, FlashState>();

  constructor(
    private readonly durationMs = FLASH_DURATION_MS,
    private readonly gapMs = FLASH_GAP_MS,
  ) {}

  /** Records a price; returns true when it started a flash. */
  observe(symbol: string, price: number | null, now: number): boolean {
    if (price == null) return false;
    const previous = this.previousPrices.get(symbol);
    this.previousPrices.set(symbol, price);
    if (previous == null || previous === price) return false;
    const current = this.flashes.get(symbol);
    if (current && now < current.nextAllowedAt) return false;
    this.flashes.set(symbol, {
      direction: resolveFlashDirection(previous, price),
      until: now + this.durationMs,
      nextAllowedAt: now + this.durationMs + this.gapMs,
    });
    return true;
  }

  /** Forgets symbols whose flash and quiet gap have both ended. */
  prune(now: number): void {
    for (const [symbol, flash] of this.flashes) {
      if (flash.nextAllowedAt <= now) this.flashes.delete(symbol);
    }
  }

  active(now: number): Map<string, QuoteFlashDirection> {
    const active = new Map<string, QuoteFlashDirection>();
    for (const [symbol, flash] of this.flashes) {
      if (flash.until > now) active.set(symbol, flash.direction);
    }
    return active;
  }

  /** When the next visible flash ends, or null when none is showing. */
  nextChangeAt(now: number): number | null {
    let next: number | null = null;
    for (const flash of this.flashes.values()) {
      if (flash.until > now && (next == null || flash.until < next)) next = flash.until;
    }
    return next;
  }

  clear(): void {
    this.flashes.clear();
  }
}

function sameFlashes(left: Map<string, QuoteFlashDirection>, right: Map<string, QuoteFlashDirection>): boolean {
  if (left.size !== right.size) return false;
  for (const [symbol, direction] of left) {
    if (right.get(symbol) !== direction) return false;
  }
  return true;
}

const EMPTY_FLASHES = new Map<string, QuoteFlashDirection>();

function useFlashTracker(
  collect: (tracker: QuoteFlashTracker, now: number) => void,
  enabled: boolean,
  deps: readonly unknown[],
): Map<string, QuoteFlashDirection> {
  const [flashes, setFlashes] = useState<Map<string, QuoteFlashDirection>>(EMPTY_FLASHES);
  const trackerRef = useRef<QuoteFlashTracker | null>(null);
  trackerRef.current ??= new QuoteFlashTracker();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publish = () => {
    const tracker = trackerRef.current!;
    const now = Date.now();
    tracker.prune(now);
    const next = tracker.active(now);
    setFlashes((current) => (sameFlashes(current, next) ? current : next.size === 0 ? EMPTY_FLASHES : next));
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    const nextAt = tracker.nextChangeAt(now);
    if (nextAt != null) {
      timeoutRef.current = setTimeout(publish, Math.max(0, nextAt - Date.now()));
    }
  };

  useEffect(() => {
    const tracker = trackerRef.current!;
    const now = Date.now();
    collect(tracker, now);
    if (!enabled) {
      tracker.clear();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      setFlashes(EMPTY_FLASHES);
      return;
    }
    publish();
  }, [enabled, ...deps]);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  return flashes;
}

export function useQuoteFlashMap(
  financialsMap: Map<string, TickerFinancials>,
  enabled: boolean,
): Map<string, QuoteFlashDirection> {
  return useFlashTracker((tracker, now) => {
    for (const [symbol, financials] of financialsMap) {
      tracker.observe(symbol, resolveFlashPrice(financials), now);
    }
  }, enabled, [financialsMap]);
}

const SINGLE_SYMBOL = "";

export function useQuoteFlashDirection(
  financials: TickerFinancials | null | undefined,
  enabled: boolean,
): QuoteFlashDirection | undefined {
  const flashes = useFlashTracker((tracker, now) => {
    tracker.observe(SINGLE_SYMBOL, resolveFlashPrice(financials), now);
  }, enabled, [financials]);
  return flashes.get(SINGLE_SYMBOL);
}
