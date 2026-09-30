import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { IpoCalendarPayload } from "../../../api-client/ipo";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PinTickerOptions } from "../../../types/plugin";
import { displayWidth } from "../../../utils/format";
import { ipoCalendarCache } from "./client";
import { IpoCalendarPane } from "./pane";
import { ipoDeal } from "./test-fixture";

const board: IpoCalendarPayload = {
  asOf: "2026-09-29T00:00:00Z",
  deals: [
    // No English name from the venue, so the company is printed in Chinese.
    ipoDeal({
      id: "catl", company: "宁德时代新能源科技股份有限公司", symbol: "3750", mic: "XHKG", exchange: "HKEX", venue: "HKEX",
      country: "HK", region: "apac", currency: "HKD", offerPrice: 263, status: "listed", listingDate: "2026-09-25",
      firstDay: { session: "2026-09-25", open: 296, close: 306.2, returnPct: 0.164 },
    }),
    ipoDeal({
      id: "arm", company: "Arm Holdings", symbol: "ARM", offerPrice: 51, status: "listed", listingDate: "2026-09-20",
      firstDay: { session: "2026-09-20", open: 56.1, close: 63.75, returnPct: 0.25 },
    }),
  ],
  sources: [
    { id: "hkex", mics: ["XHKG"], ok: true, asOf: "2026-09-29T00:00:00Z" },
    { id: "nasdaq", mics: ["XNAS", "XNYS"], ok: true, asOf: "2026-09-29T00:00:00Z" },
    { id: "nse", mics: ["XNSE"], ok: false, asOf: null },
  ],
};

const tui = createOpenTuiTestHarness();
afterEach(() => {
  setCloudApiFetchTransport(null);
  ipoCalendarCache.reset();
});

async function mount(width = 110, height = 10) {
  ipoCalendarCache.attach(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async () => Response.json(board));
  const id = "ipo-calendar";
  const initial = createInitialState(createTestPaneConfig(":memory:", { instanceId: id, paneId: id, settings: {} }));
  const pins: { symbol: string; options?: PinTickerOptions }[] = [];
  function Harness() {
    const [state, setState] = useState(initial);
    const dispatch = (action: AppAction) => setState((current) => appReducer(current, action));
    return (
      <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="ipo-calendar"
        runtime={createTestPluginRuntime({ getMarketData: () => null, pinTicker: (symbol, options) => { pins.push({ symbol, options }); } })}
        width={width} height={height}>
        {(body) => <IpoCalendarPane paneId={id} paneType={id} focused {...body} />}
      </TestPaneFrame>
    );
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
  await tui.waitForFrameToContain("3750");
  return { pins };
}

/** The cell a text starts on, counting a CJK character as the two cells it takes. */
function cellOf(line: string, text: string): number {
  const index = line.indexOf(text);
  return index < 0 ? -1 : displayWidth(line.slice(0, index));
}

test("a company printed in Chinese keeps every column after it in line", async () => {
  await mount();
  const lines = tui.frame().split("\n");
  const hk = lines.find((line) => line.includes("3750"))!;
  const us = lines.find((line) => line.includes("ARM"))!;
  expect(hk).toContain("宁德时代");
  expect(cellOf(hk, "HKEX")).toBe(cellOf(us, "Nasdaq"));
  expect(cellOf(hk, "HK$263") + "HK$263".length).toBe(cellOf(us, "$51") + "$51".length);
  expect(cellOf(hk, "+16.4%")).toBe(cellOf(us, "+25.0%"));
  // The market with no fresh data is named, not its source.
  expect(lines.find((line) => line.includes("[/]search"))).toContain("India not updated");
});

test("Enter opens a Hong Kong code on its own exchange, never a US ticker of the same name", async () => {
  const { pins } = await mount();
  await act(async () => tui.setup().mockInput.pressEnter());
  await settleFrame(tui.setup(), 10);
  expect(pins.map((pin) => pin.symbol)).toEqual(["3750:XHKG"]);
});
