import { useEffect, useRef } from "react";
import type { TickerFinancials } from "../types/financials";
import { getActiveQuoteDisplay } from "../market-data/market/status";
import { useDataFrameWake } from "../market-data/frame-wake";

export type QuoteFlashDirection = "up" | "down" | "flat";

/** How long a changed price stays flashed. */
const FLASH_DURATION_MS = 300;
/**
 * Quiet time after a flash before the same symbol may flash again. Streamed
 * prices can change several times a second; without a gap a busy symbol would
 * stay dimmed and its price would be harder to read than a quiet one's.
 */
const FLASH_GAP_MS = 300;

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

function sameDeps(left: readonly unknown[] | null, right: readonly unknown[]): boolean {
  return !!left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

/**
 * The flashes to show. New prices are observed while rendering, so a price and
 * its flash reach the screen in the same commit, and a flash ends in the first
 * market data frame after it is due, with whatever quotes that frame brings:
 * neither costs a commit (in the terminal, a full redraw) of its own.
 */
function useFlashTracker(
  collect: (tracker: QuoteFlashTracker, now: number) => void,
  enabled: boolean,
  deps: readonly unknown[],
): Map<string, QuoteFlashDirection> {
  const trackerRef = useRef<QuoteFlashTracker | null>(null);
  trackerRef.current ??= new QuoteFlashTracker();
  const tracker = trackerRef.current;
  const observedRef = useRef<readonly unknown[] | null>(null);
  const shownRef = useRef<Map<string, QuoteFlashDirection>>(EMPTY_FLASHES);
  const clock = useDataFrameWake();

  const now = clock.now();
  // Once per set of inputs: a render for any other reason (or a repeated one) observes nothing.
  if (!sameDeps(observedRef.current, deps)) {
    observedRef.current = deps;
    collect(tracker, now);
  }
  let flashes = EMPTY_FLASHES;
  if (!enabled) {
    tracker.clear();
  } else {
    tracker.prune(now);
    const active = tracker.active(now);
    flashes = sameFlashes(shownRef.current, active) ? shownRef.current : active.size === 0 ? EMPTY_FLASHES : active;
  }
  shownRef.current = flashes;
  const endsAt = enabled ? tracker.nextChangeAt(now) : null;

  // Booked after every render that still shows a flash.
  useEffect(() => {
    if (endsAt != null) clock.wakeAt(endsAt);
    else clock.cancel();
  });

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
