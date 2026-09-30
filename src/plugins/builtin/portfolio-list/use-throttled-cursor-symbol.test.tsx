import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { useThrottledCursorSymbol } from "./use-throttled-cursor-symbol";

const tui = createOpenTuiTestHarness();
let setHarnessCursorSymbol: ((symbol: string | null, options?: { immediate?: boolean }) => void) | null = null;
let flushHarnessCursorSymbol: ((symbol?: string | null) => void) | null = null;
let latestCursorSymbol: string | null = null;
let latestCommittedCursorSymbol: string | null = null;

const TEST_THROTTLE_MS = 80;

function ThrottledCursorHarness() {
  const [committedCursorSymbol, setCommittedCursorSymbol] = useState<string | null>("AAPL");
  const {
    cursorSymbol,
    setCursorSymbol,
    flushCursorSymbol,
  } = useThrottledCursorSymbol(committedCursorSymbol, setCommittedCursorSymbol, TEST_THROTTLE_MS);

  latestCursorSymbol = cursorSymbol;
  latestCommittedCursorSymbol = committedCursorSymbol;
  setHarnessCursorSymbol = setCursorSymbol;
  flushHarnessCursorSymbol = flushCursorSymbol;

  return <text>{cursorSymbol ?? "none"}|{committedCursorSymbol ?? "none"}</text>;
}

afterEach(() => {
  setHarnessCursorSymbol = null;
  flushHarnessCursorSymbol = null;
  latestCursorSymbol = null;
  latestCommittedCursorSymbol = null;
});

describe("useThrottledCursorSymbol", () => {
  test("commits the first step at once and settles the rest of a burst to its last symbol", async () => {
    await tui.render(<ThrottledCursorHarness />, {
      width: 24,
      height: 1,
    });

    await act(async () => {
      await tui.setup().renderOnce();
    });

    await act(async () => {
      setHarnessCursorSymbol?.("MSFT");
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    // A single step reaches followers without waiting out the throttle.
    expect(latestCursorSymbol).toBe("MSFT");
    expect(latestCommittedCursorSymbol).toBe("MSFT");

    await act(async () => {
      setHarnessCursorSymbol?.("NVDA");
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    // A second step inside the window is deferred, so a held key cannot
    // commit every row it passes.
    expect(latestCursorSymbol).toBe("NVDA");
    expect(latestCommittedCursorSymbol).toBe("MSFT");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TEST_THROTTLE_MS + 20));
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    expect(latestCommittedCursorSymbol).toBe("NVDA");
  });

  test("coalesces repeated cursor moves into the final committed symbol", async () => {
    await tui.render(<ThrottledCursorHarness />, {
      width: 24,
      height: 1,
    });

    await act(async () => {
      await tui.setup().renderOnce();
    });

    await act(async () => {
      setHarnessCursorSymbol?.("MSFT");
      await Promise.resolve();
    });
    await act(async () => {
      setHarnessCursorSymbol?.("NVDA");
      await Promise.resolve();
    });
    await act(async () => {
      setHarnessCursorSymbol?.("AMD");
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    expect(latestCursorSymbol).toBe("AMD");
    expect(latestCommittedCursorSymbol).toBe("MSFT");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TEST_THROTTLE_MS + 20));
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    expect(latestCommittedCursorSymbol).toBe("AMD");
  });

  test("can flush a pending cursor immediately", async () => {
    await tui.render(<ThrottledCursorHarness />, {
      width: 24,
      height: 1,
    });

    await act(async () => {
      await tui.setup().renderOnce();
    });

    await act(async () => {
      setHarnessCursorSymbol?.("MSFT");
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    await act(async () => {
      setHarnessCursorSymbol?.("NVDA");
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    expect(latestCommittedCursorSymbol).toBe("MSFT");

    await act(async () => {
      flushHarnessCursorSymbol?.("NVDA");
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    expect(latestCommittedCursorSymbol).toBe("NVDA");
  });
});
