import { describe, expect, test } from "bun:test";
import { QuoteFlashTracker } from "./quote-flash";

describe("QuoteFlashTracker", () => {
  test("flashes each symbol on its own clock", () => {
    const tracker = new QuoteFlashTracker(300, 300);
    tracker.observe("AAPL", 100, 0);
    tracker.observe("MSFT", 50, 0);
    tracker.observe("AAPL", 101, 1_000);
    tracker.observe("MSFT", 49, 1_200);

    // A later MSFT tick must not end AAPL's flash early.
    expect(tracker.active(1_250)).toEqual(new Map([["AAPL", "up"], ["MSFT", "down"]]));
    expect(tracker.nextChangeAt(1_250)).toBe(1_300);
    expect(tracker.active(1_300)).toEqual(new Map([["MSFT", "down"]]));
  });

  test("keeps a quiet gap between flashes of a busy symbol", () => {
    const tracker = new QuoteFlashTracker(300, 300);
    tracker.observe("SPY", 500, 0);
    expect(tracker.observe("SPY", 501, 1_000)).toBe(true);
    // Ticks during the flash and the gap move the price without re-flashing.
    expect(tracker.observe("SPY", 502, 1_100)).toBe(false);
    expect(tracker.observe("SPY", 500, 1_450)).toBe(false);
    tracker.prune(1_600);
    // The direction is judged against the last seen price, not the flashed one.
    expect(tracker.observe("SPY", 499, 1_600)).toBe(true);
    expect(tracker.active(1_650).get("SPY")).toBe("down");
  });
});
