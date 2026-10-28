import { describe, expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import type { InstrumentSearchResult } from "../../../types/instrument";
import { CommandBarHarness } from "./test-harness";

const tui = createOpenTuiTestHarness();
const nvda: InstrumentSearchResult = {
  providerId: "test", symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ", currency: "USD", type: "EQUITY",
};

// Signed out, the only row while the symbol search is out is the sign-up offer,
// which is never the answer to a typed symbol. Enter must not take it.
describe("Enter before the symbol search answers", () => {
  async function renderHeldSearch(results: InstrumentSearchResult[] = [nvda]) {
    const opened: string[] = [];
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    await tui.render(<CommandBarHarness
      query="NVDA"
      live
      showQueryState
      configurePluginRegistry={(registry) => { registry.pinTicker = (key) => { opened.push(key); }; }}
      dataProvider={createTestDataProvider({
        search: async () => { await held; return results; },
        getQuote: async () => createTestQuote({ symbol: "NVDA", name: "NVIDIA Corporation" }),
      })}
    />, { width: 110, height: 28 });
    await tui.waitForFrameToContain("Ask AI — sign up to enable");
    return { opened, release };
  }

  test("waits for the answer and opens the symbol, not Sign Up", async () => {
    const { opened, release } = await renderHeldSearch();
    try {
      await tui.emitKeypress({ name: "return", sequence: "\r" });
      expect(tui.frame()).toContain("query:NVDA");
      expect(tui.frame()).toContain("bar:open");
      expect(opened).toEqual([]);
    } finally {
      release();
    }
    await tui.waitForFrameToContain("bar:closed");
    expect(opened).toEqual(["NVDA"]);
  });

  test("typing on takes the Enter back", async () => {
    const { opened, release } = await renderHeldSearch();
    try {
      await tui.emitKeypress({ name: "return", sequence: "\r" });
      await tui.emitKeypress({ name: "x", sequence: "x" });
      await tui.waitForFrameToContain("query:NVDAx");
    } finally {
      release();
    }
    // The answer lands for the new text and finds nothing waiting on it.
    await tui.waitForFrameToExclude("Searching", 20);
    expect(tui.frame()).toContain("bar:open");
    expect(opened).toEqual([]);
  });

  test("a row picked on purpose runs at once", async () => {
    const { opened, release } = await renderHeldSearch();
    try {
      await tui.emitKeypress({ name: "down" });
      await tui.emitKeypress({ name: "return", sequence: "\r" });
      await tui.waitForFrameToContain("query:Sign Up");
      expect(opened).toEqual([]);
    } finally {
      release();
    }
  });

  test("an answer with nothing to open leaves the bar as it is", async () => {
    const { opened, release } = await renderHeldSearch([]);
    try {
      await tui.emitKeypress({ name: "return", sequence: "\r" });
    } finally {
      release();
    }
    await tui.waitForFrameToExclude("Searching");
    expect(tui.frame()).toContain("query:NVDA");
    expect(tui.frame()).toContain("bar:open");
    expect(opened).toEqual([]);
  });
});
