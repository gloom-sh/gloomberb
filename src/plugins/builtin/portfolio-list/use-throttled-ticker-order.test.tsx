import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { useThrottledTickerOrder } from "./use-throttled-ticker-order";

const TEST_THROTTLE_MS = 80;
const tui = createOpenTuiTestHarness();
let updateCandidates: ((symbols: string[]) => void) | null = null;
let updateResetKey: ((key: string) => void) | null = null;
let updateValued: ((symbols: string[] | undefined) => void) | null = null;
let latestOrder: string[] = [];

function ThrottledOrderHarness() {
  const [candidates, setCandidates] = useState(["AAPL", "MSFT", "NVDA"]);
  const [resetKey, setResetKey] = useState("price:desc");
  // Undefined: an order without values arriving. A new Set each time, like the pane's per-tick sort.
  const [valued, setValued] = useState<string[] | undefined>(undefined);
  latestOrder = useThrottledTickerOrder(candidates, resetKey, {
    throttleMs: TEST_THROTTLE_MS,
    valuedSymbols: valued ? new Set(valued) : undefined,
  });
  updateCandidates = setCandidates;
  updateResetKey = setResetKey;
  updateValued = setValued;
  return <text>{latestOrder.join(",")}</text>;
}

afterEach(() => {
  updateCandidates = null;
  updateResetKey = null;
  updateValued = null;
  latestOrder = [];
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => tui.setup().renderOnce());
}

describe("useThrottledTickerOrder", () => {
  test("coalesces rapid market-driven reorders into the latest trailing order", async () => {
    await tui.render(<ThrottledOrderHarness />, { width: 32, height: 1 });
    await act(async () => tui.setup().renderOnce());

    await act(async () => {
      updateCandidates?.(["MSFT", "AAPL", "NVDA"]);
      await Promise.resolve();
    });
    await act(async () => tui.setup().renderOnce());
    expect(latestOrder).toEqual(["MSFT", "AAPL", "NVDA"]);

    await act(async () => {
      updateCandidates?.(["NVDA", "MSFT", "AAPL"]);
      await Promise.resolve();
    });
    await act(async () => tui.setup().renderOnce());
    expect(latestOrder).toEqual(["MSFT", "AAPL", "NVDA"]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TEST_THROTTLE_MS + 20));
    });
    await act(async () => tui.setup().renderOnce());
    expect(latestOrder).toEqual(["NVDA", "MSFT", "AAPL"]);
  });

  test("applies user sort changes and ticker membership changes immediately", async () => {
    await tui.render(<ThrottledOrderHarness />, { width: 32, height: 1 });
    await act(async () => tui.setup().renderOnce());

    await act(async () => {
      updateCandidates?.(["NVDA", "MSFT", "AAPL"]);
      updateResetKey?.("price:asc");
      await Promise.resolve();
    });
    await act(async () => tui.setup().renderOnce());
    expect(latestOrder).toEqual(["NVDA", "MSFT", "AAPL"]);

    await act(async () => {
      updateCandidates?.(["AMD", "NVDA", "MSFT", "AAPL"]);
      await Promise.resolve();
    });
    await act(async () => tui.setup().renderOnce());
    expect(latestOrder).toEqual(["AMD", "NVDA", "MSFT", "AAPL"]);
  });

  test("puts rows in their order the moment they get their first value, then throttles reshuffles among them", async () => {
    await tui.render(<ThrottledOrderHarness />, { width: 32, height: 1 });
    await act(async () => tui.setup().renderOnce());

    // The list loads before its prices: members arrive, the order is the listed one.
    await act(async () => {
      updateValued?.([]);
      updateCandidates?.(["AAPL", "AMD", "MSFT", "NVDA"]);
    });
    await settle();
    expect(latestOrder).toEqual(["AAPL", "AMD", "MSFT", "NVDA"]);

    // The prices land right behind it, inside the throttle window of that commit.
    await act(async () => {
      updateValued?.(["AAPL", "AMD", "MSFT", "NVDA"]);
      updateCandidates?.(["NVDA", "MSFT", "AMD", "AAPL"]);
    });
    await settle();
    expect(latestOrder).toEqual(["NVDA", "MSFT", "AMD", "AAPL"]);

    // A live reshuffle among rows that already had values waits for the window.
    await act(async () => {
      updateCandidates?.(["MSFT", "NVDA", "AMD", "AAPL"]);
    });
    await settle();
    expect(latestOrder).toEqual(["NVDA", "MSFT", "AMD", "AAPL"]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TEST_THROTTLE_MS + 20));
    });
    await act(async () => tui.setup().renderOnce());
    expect(latestOrder).toEqual(["MSFT", "NVDA", "AMD", "AAPL"]);
  });

  test("keeps the throttle for a row that loses its value and gets it back", async () => {
    await tui.render(<ThrottledOrderHarness />, { width: 32, height: 1 });
    await act(async () => tui.setup().renderOnce());
    await act(async () => {
      updateValued?.(["AAPL", "MSFT", "NVDA"]);
    });
    await settle();

    await act(async () => {
      updateValued?.(["AAPL", "MSFT"]);
      updateCandidates?.(["MSFT", "AAPL", "NVDA"]);
    });
    await settle();
    expect(latestOrder).toEqual(["MSFT", "AAPL", "NVDA"]);

    await act(async () => {
      updateValued?.(["AAPL", "MSFT", "NVDA"]);
      updateCandidates?.(["NVDA", "MSFT", "AAPL"]);
    });
    await settle();
    expect(latestOrder).toEqual(["MSFT", "AAPL", "NVDA"]);
  });
});
