import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { AppContextStoreValue } from "../../../state/app/context";
import { CommandBarHarness, createCommandBarTestControls } from "./test-harness";

const tui = createOpenTuiTestHarness();
const { waitForFrameToContain, clickFrameText } = createCommandBarTestControls(() => tui.setup());

const search = createTestDataProvider({
  id: "test",
  search: async (query) => query.toUpperCase().startsWith("AAPL")
    ? [{ providerId: "test", symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", currency: "USD", type: "EQUITY" }]
    : [],
});

async function renderPicker(query: string, storeRef: { current: AppContextStoreValue | null }) {
  await tui.render(<CommandBarHarness
    query={query}
    live
    storeRef={storeRef}
    dataProvider={search}
    configureConfig={(config) => ({ ...config, headerMarket: { benchmark: "sp500" } })}
  />, { width: 100, height: 30 });
  await tui.setup().renderOnce();
}

test("the Header Market command lists the benchmarks and saves the one picked", async () => {
  const storeRef: { current: AppContextStoreValue | null } = { current: null };
  await renderPicker("Header Market", storeRef);
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await waitForFrameToContain("Hang Seng");
  expect(tui.frame()).toContain("Nikkei 225");

  await act(async () => { await tui.setup().mockInput.typeText("hong kong"); });
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await waitForFrameToContain("bar:closed");
  expect(storeRef.current!.getState().config.headerMarket).toEqual({ benchmark: "hang-seng" });
  // The header follows the choice at once.
  expect(tui.frame().split("\n")[0]).toContain("Hang Seng");
});

test("a click on the header's market opens the picker, and a ticker found there is saved with its listing", async () => {
  const storeRef: { current: AppContextStoreValue | null } = { current: null };
  await renderPicker("", storeRef);
  await act(async () => { storeRef.current!.dispatch({ type: "SET_COMMAND_BAR", open: false }); });
  await waitForFrameToContain("bar:closed");

  await clickFrameText("S&P 500");
  await waitForFrameToContain("Benchmarks");
  await act(async () => { await tui.setup().mockInput.typeText("AAPL"); });
  await waitForFrameToContain("Apple Inc.");
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await waitForFrameToContain("bar:closed");
  expect(storeRef.current!.getState().config.headerMarket).toEqual({ symbol: "AAPL", exchange: "NASDAQ" });
});
