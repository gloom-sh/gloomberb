import { instrumentIdentityKey } from "../../../utils/instrument-identity";

/**
 * Quote streams cross from the backend process to a window as one message per
 * short interval holding the latest tick per instrument, instead of one RPC
 * message per tick. Other events on the same stream keep their order.
 */
export const QUOTE_EVENT_BATCH_KIND = "quote-batch";
export const QUOTE_EVENT_BATCH_INTERVAL_MS = 40;

export interface QuoteEventBatch {
  kind: typeof QUOTE_EVENT_BATCH_KIND;
  events: unknown[];
  /** The backend's measured server clock offset, which the window's freshness checks need too. */
  clockOffsetMs?: number;
}

/** Operations whose events are `{ target, quote }` (asset data) or `{ kind: "quote", target, quote }` (brokers). */
export function isBatchableQuoteOperation(operationId: string): boolean {
  return operationId === "subscribeQuotes" || operationId === "quotes";
}

export function quoteEventInstrumentKey(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const { kind, target, quote } = event as {
    kind?: unknown;
    target?: { symbol?: unknown; exchange?: unknown; context?: Record<string, unknown> };
    quote?: unknown;
  };
  if (!quote || !target || typeof target.symbol !== "string" || (kind !== undefined && kind !== "quote")) return null;
  const context = target.context ?? {};
  return instrumentIdentityKey({
    symbol: target.symbol,
    exchange: typeof target.exchange === "string" ? target.exchange : "",
    brokerId: typeof context.brokerId === "string" ? context.brokerId : undefined,
    brokerInstanceId: typeof context.brokerInstanceId === "string" ? context.brokerInstanceId : undefined,
    instrument: context.instrument as Parameters<typeof instrumentIdentityKey>[0]["instrument"],
  });
}

export function isQuoteEventBatch(event: unknown): event is QuoteEventBatch {
  return !!event && typeof event === "object"
    && (event as { kind?: unknown }).kind === QUOTE_EVENT_BATCH_KIND
    && Array.isArray((event as { events?: unknown }).events);
}

/** A window reads batched and single events the same way. */
export function unpackQuoteEvents(event: unknown): { events: unknown[]; clockOffsetMs?: number } {
  if (!isQuoteEventBatch(event)) return { events: [event] };
  return {
    events: event.events,
    ...(typeof event.clockOffsetMs === "number" && Number.isFinite(event.clockOffsetMs)
      ? { clockOffsetMs: event.clockOffsetMs }
      : {}),
  };
}

/**
 * Collects the quote events of one stream and sends them as a batch per
 * interval, latest tick per instrument. The timer runs only while ticks wait.
 */
export class QuoteEventBatcher {
  private readonly pending = new Map<string, unknown>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (event: unknown) => void,
    private readonly readClockOffset: () => number | null = () => null,
    private readonly intervalMs = QUOTE_EVENT_BATCH_INTERVAL_MS,
  ) {}

  push(event: unknown): void {
    const key = quoteEventInstrumentKey(event);
    if (key === null) {
      this.flush();
      this.send(event);
      return;
    }
    this.pending.set(key, event);
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    const events = [...this.pending.values()];
    this.pending.clear();
    const clockOffsetMs = this.readClockOffset();
    const batch: QuoteEventBatch = {
      kind: QUOTE_EVENT_BATCH_KIND,
      events,
      ...(clockOffsetMs != null ? { clockOffsetMs } : {}),
    };
    this.send(batch);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
