import { expect, test } from "bun:test";
import type { QuoteSubscriptionTarget } from "../../../../types/data-provider";
import type { Quote } from "../../../../types/financials";
import { QUOTE_EVENT_BATCH_KIND } from "../../shared/quote-event-batch";
import { createBackendQuoteSubscription } from "./backend-quote-subscription";

function createBackend() {
  const log: string[] = [];
  const pending = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
  const listeners = new Map<string, (event: unknown) => void>();
  const dispatched: Array<[string, number]> = [];
  const offsets: number[] = [];
  const backend = createBackendQuoteSubscription({
    subscribe: (id, targets) => {
      log.push(`subscribe ${id} ${targets.map((target) => `${target.symbol}${target.selected ? "*" : ""}`).join(",")}`);
      return new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    unsubscribe: (id) => { log.push(`unsubscribe ${id}`); },
    onEvent: (id, listener) => {
      listeners.set(id, listener);
      return () => listeners.delete(id);
    },
    dispatch: (target, quote) => dispatched.push([target.symbol, quote.price]),
    onClockOffset: (offset) => offsets.push(offset),
  });
  const settle = async (id: string, ok = true) => {
    const request = pending.get(id)!;
    if (ok) request.resolve();
    else request.reject(new Error("backend unavailable"));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { backend, log, settle, listeners, dispatched, offsets };
}

const target = (symbol: string, selected = false): QuoteSubscriptionTarget => ({ symbol, exchange: "NASDAQ", visible: true, selected });
const quote = (symbol: string, price: number): Quote => ({ symbol, price, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1 });

test("a priority change registers the new set before the old one is retired", async () => {
  const { backend, log, settle } = createBackend();
  backend.sync([target("AAPL"), target("MSFT")]);
  await settle("quote:1");
  backend.sync([target("AAPL"), target("MSFT")]);
  expect(log).toEqual(["subscribe quote:1 AAPL,MSFT"]);

  backend.sync([target("AAPL", true), target("MSFT")]);
  expect(log.at(-1)).toBe("subscribe quote:2 AAPL*,MSFT");
  expect(log).not.toContain("unsubscribe quote:1");
  await settle("quote:2");
  expect(log.at(-1)).toBe("unsubscribe quote:1");

  // Replaced while in flight: its own unsubscribe waits for its subscribe to land.
  backend.sync([target("AAPL")]);
  backend.sync([target("MSFT")]);
  await settle("quote:4");
  expect(log.slice(-3)).toEqual(["subscribe quote:3 AAPL", "subscribe quote:4 MSFT", "unsubscribe quote:2"]);
  await settle("quote:3");
  expect(log.at(-1)).toBe("unsubscribe quote:3");
});

test("a failed subscribe keeps the set that is still live in the backend", async () => {
  const { backend, log, settle } = createBackend();
  backend.sync([target("AAPL")]);
  await settle("quote:1");
  backend.sync([target("AAPL"), target("MSFT")]);
  await settle("quote:2", false);
  expect(log).not.toContain("unsubscribe quote:1");

  // The same targets retry instead of being treated as already sent.
  backend.sync([target("AAPL"), target("MSFT")]);
  expect(log.at(-1)).toBe("subscribe quote:3 AAPL,MSFT");
  await settle("quote:3");
  expect(log.at(-1)).toBe("unsubscribe quote:1");
});

test("delivers every tick of a batch and forwards the backend clock offset", () => {
  const { backend, listeners, dispatched, offsets } = createBackend();
  backend.sync([target("AAPL"), target("MSFT")]);
  listeners.get("quote:1")!({
    kind: QUOTE_EVENT_BATCH_KIND,
    clockOffsetMs: 1_200,
    events: [{ target: target("AAPL"), quote: quote("AAPL", 231) }, { target: target("MSFT"), quote: quote("MSFT", 510) }],
  });
  listeners.get("quote:1")!({ target: target("AAPL"), quote: quote("AAPL", 232) });
  expect(dispatched).toEqual([["AAPL", 231], ["MSFT", 510], ["AAPL", 232]]);
  expect(offsets).toEqual([1_200]);
});
