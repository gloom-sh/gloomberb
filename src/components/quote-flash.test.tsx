import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { createManualFrameDriver, createTimerFrameDriver, installMarketDataFrameDriver, marketDataFrames } from "../market-data/frame-scheduler";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import type { TickerFinancials } from "../types/financials";
import { QuoteFlashTracker, useQuoteFlashDirection, useQuoteFlashMap, type QuoteFlashDirection } from "./quote-flash";

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

describe("quote flash hooks", () => {
  const tui = createOpenTuiTestHarness();
  const clock = createManualFrameDriver(100);
  let renders: Array<Map<string, QuoteFlashDirection>> = [];
  let directions: Array<QuoteFlashDirection | undefined> = [];
  let setPrice: ((price: number) => void) | null = null;
  let setEnabled: ((enabled: boolean) => void) | null = null;
  let setShown: ((shown: boolean) => void) | null = null;

  function FlashHarness() {
    const [price, update] = useState(100);
    setPrice = update;
    const financials = useMemo(() => new Map([["AAPL", { quote: { price } } as TickerFinancials]]), [price]);
    const flashes = useQuoteFlashMap(financials, true);
    renders.push(flashes);
    return <text>{flashes.get("AAPL") ?? "-"}</text>;
  }

  function Mounted() {
    const [shown, show] = useState(true);
    setShown = show;
    return shown ? <FlashHarness /> : <text>-</text>;
  }

  function DirectionHarness() {
    const [price, update] = useState(100);
    const [enabled, enable] = useState(false);
    setPrice = update;
    setEnabled = enable;
    const financials = useMemo(() => ({ quote: { price } } as TickerFinancials), [price]);
    const direction = useQuoteFlashDirection(financials, enabled);
    directions.push(direction);
    return <text>{direction ?? "-"}</text>;
  }

  beforeEach(() => {
    installMarketDataFrameDriver(clock.driver);
    renders = [];
    directions = [];
  });
  afterEach(() => {
    installMarketDataFrameDriver(createTimerFrameDriver(0));
    setPrice = null;
    setEnabled = null;
    setShown = null;
  });

  test("a price flashes in the render that shows it, and the flash ends with a data frame rather than a commit of its own", async () => {
    await tui.render(<FlashHarness />, { width: 8, height: 1 });
    expect(renders.map((flashes) => flashes.size)).toEqual([0]);

    await act(async () => setPrice!(101));
    // One render, flash included: no effect sets it a commit later.
    expect(renders.map((flashes) => flashes.get("AAPL"))).toEqual([undefined, "up"]);

    // Due at 300 ms, the end waits for the next frame that brings quotes...
    await act(async () => clock.advance(350));
    expect(renders).toHaveLength(2);
    await act(async () => {
      marketDataFrames.request(() => {}, { phase: "notify" });
      clock.advance(0);
    });
    expect(renders.map((flashes) => flashes.get("AAPL"))).toEqual([undefined, "up", undefined]);

    // ...and with none, comes at most a frame interval late.
    await act(async () => clock.advance(350));
    await act(async () => setPrice!(100));
    expect(renders.at(-1)?.get("AAPL")).toBe("down");
    await act(async () => clock.advance(399));
    expect(renders.at(-1)?.get("AAPL")).toBe("down");
    await act(async () => clock.advance(1));
    expect(renders.at(-1)?.get("AAPL")).toBeUndefined();
    expect(clock.pending).toBe(false);
  });

  test("unmounting drops the render booked for a flash's end", async () => {
    await tui.render(<Mounted />, { width: 8, height: 1 });
    await act(async () => setPrice!(101));
    expect(clock.pending).toBe(true);
    await act(async () => setShown!(false));
    expect(clock.pending).toBe(false);
  });

  test("a single quote shows no flash and books no render while flashing is off, and flashes on its next change once on", async () => {
    await tui.render(<DirectionHarness />, { width: 8, height: 1 });
    await act(async () => setPrice!(101));
    expect(directions).toEqual([undefined, undefined]);
    expect(clock.pending).toBe(false);

    // Turned on within what would have been the flash, it does not show it late.
    await act(async () => setEnabled!(true));
    expect(directions.at(-1)).toBeUndefined();
    expect(clock.pending).toBe(false);
    await act(async () => setPrice!(100));
    expect(directions.at(-1)).toBe("down");
  });
});
