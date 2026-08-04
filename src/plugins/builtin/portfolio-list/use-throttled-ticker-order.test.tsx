import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { useThrottledTickerOrder } from "./use-throttled-ticker-order";

const TEST_THROTTLE_MS = 80;
let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let updateCandidates: ((symbols: string[]) => void) | null = null;
let updateResetKey: ((key: string) => void) | null = null;
let latestOrder: string[] = [];

function ThrottledOrderHarness() {
  const [candidates, setCandidates] = useState(["AAPL", "MSFT", "NVDA"]);
  const [resetKey, setResetKey] = useState("price:desc");
  latestOrder = useThrottledTickerOrder(candidates, resetKey, TEST_THROTTLE_MS);
  updateCandidates = setCandidates;
  updateResetKey = setResetKey;
  return <text>{latestOrder.join(",")}</text>;
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => testSetup!.renderer.destroy());
    testSetup = undefined;
  }
  updateCandidates = null;
  updateResetKey = null;
  latestOrder = [];
});

describe("useThrottledTickerOrder", () => {
  test("coalesces rapid market-driven reorders into the latest trailing order", async () => {
    testSetup = await testRender(<ThrottledOrderHarness />, { width: 32, height: 1 });
    await act(async () => testSetup!.renderOnce());

    await act(async () => {
      updateCandidates?.(["MSFT", "AAPL", "NVDA"]);
      await Promise.resolve();
    });
    await act(async () => testSetup!.renderOnce());
    expect(latestOrder).toEqual(["MSFT", "AAPL", "NVDA"]);

    await act(async () => {
      updateCandidates?.(["NVDA", "MSFT", "AAPL"]);
      await Promise.resolve();
    });
    await act(async () => testSetup!.renderOnce());
    expect(latestOrder).toEqual(["MSFT", "AAPL", "NVDA"]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TEST_THROTTLE_MS + 20));
    });
    await act(async () => testSetup!.renderOnce());
    expect(latestOrder).toEqual(["NVDA", "MSFT", "AAPL"]);
  });

  test("applies user sort changes and ticker membership changes immediately", async () => {
    testSetup = await testRender(<ThrottledOrderHarness />, { width: 32, height: 1 });
    await act(async () => testSetup!.renderOnce());

    await act(async () => {
      updateCandidates?.(["NVDA", "MSFT", "AAPL"]);
      updateResetKey?.("price:asc");
      await Promise.resolve();
    });
    await act(async () => testSetup!.renderOnce());
    expect(latestOrder).toEqual(["NVDA", "MSFT", "AAPL"]);

    await act(async () => {
      updateCandidates?.(["AMD", "NVDA", "MSFT", "AAPL"]);
      await Promise.resolve();
    });
    await act(async () => testSetup!.renderOnce());
    expect(latestOrder).toEqual(["AMD", "NVDA", "MSFT", "AAPL"]);
  });
});
