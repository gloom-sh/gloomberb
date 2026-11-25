import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { TickerRecord } from "../../../types/ticker";
import { useCursorNeighborPrefetch } from "./use-cursor-neighbor-prefetch";
import { createTestTicker } from "../../../test-support/ticker";

function createTicker(symbol: string): TickerRecord {
  return createTestTicker(symbol);
}

const TICKERS = ["AAPL", "MSFT", "NVDA", "AMD", "TSLA", "META"].map(createTicker);

let noteCursor: ((symbol: string | null) => void) | null = null;
let prefetched: string[] = [];

function Harness({ cursorSymbol, enabled = true }: { cursorSymbol: string | null; enabled?: boolean }) {
  noteCursor = useCursorNeighborPrefetch({
    tickers: TICKERS,
    cursorSymbol,
    portfolioId: undefined,
    enabled,
    prefetch: (instrument: InstrumentRef) => {
      prefetched.push(instrument.symbol);
    },
  });
  return <text>{cursorSymbol ?? "none"}</text>;
}

const advanceClock = (ms: number) => act(async () => {
  jest.advanceTimersByTime(ms);
});

describe("useCursorNeighborPrefetch", () => {
  const tui = createOpenTuiTestHarness();

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    noteCursor = null;
    prefetched = [];
  });

  test("warms the near ring once the cursor rests and the far ring after it settles", async () => {
    await tui.render(<Harness cursorSymbol={null} />, { width: 10, height: 1 });
    await act(async () => { noteCursor?.("NVDA"); });

    await advanceClock(79);
    expect(prefetched).toEqual([]);

    await advanceClock(1);
    expect(prefetched.sort()).toEqual(["AMD", "MSFT", "NVDA"]);

    await advanceClock(519);
    expect(prefetched.sort()).toEqual(["AMD", "MSFT", "NVDA"]);

    await advanceClock(1);
    expect(prefetched.sort()).toEqual(["AAPL", "AMD", "MSFT", "NVDA", "TSLA"]);
  });

  test("only warms the final cursor in a rapid burst", async () => {
    await tui.render(<Harness cursorSymbol={null} />, { width: 10, height: 1 });
    for (const symbol of ["MSFT", "NVDA", "AMD", "TSLA"]) {
      await act(async () => { noteCursor?.(symbol); });
      await advanceClock(30);
    }
    expect(prefetched).toEqual([]);

    await advanceClock(50);
    expect(prefetched.sort()).toEqual(["AMD", "META", "TSLA"]);

    await advanceClock(520);
    expect(prefetched.sort()).toEqual(["AMD", "META", "NVDA", "TSLA"]);
  });

  test("follows the throttled cursor when the list does not report a live one", async () => {
    await tui.render(<Harness cursorSymbol="AAPL" />, { width: 10, height: 1 });
    await advanceClock(80);
    expect(prefetched.sort()).toEqual(["AAPL", "MSFT"]);
  });

  test("does nothing while the app is inactive", async () => {
    await tui.render(<Harness cursorSymbol="AAPL" enabled={false} />, { width: 10, height: 1 });
    await advanceClock(600);
    expect(prefetched).toEqual([]);
  });
});
