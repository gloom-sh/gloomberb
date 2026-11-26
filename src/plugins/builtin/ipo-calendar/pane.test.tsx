import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { IpoCalendarPayload } from "../../../api-client/ipo";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PaneTemplateContext, PinTickerOptions } from "../../../types/plugin";
import { displayWidth } from "../../../utils/format";
import { ipoCalendarCache } from "./client";
import { ipoCalendarPlugin } from "./index";
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
    // Still ahead, in its book: on the Upcoming list, with no return to show.
    ipoDeal({ id: "next", company: "Next Robotics", symbol: "NXRB", priceLow: 18, priceHigh: 20, listingDate: "2099-01-15" }),
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

async function mount(width = 110, height = 10, params?: Record<string, string>, list: "upcoming" | "listed" | null = "listed") {
  ipoCalendarCache.attach(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async () => Response.json(board));
  const id = "ipo-calendar";
  const config = createInitialState(createTestPaneConfig(":memory:", { instanceId: id, paneId: id, settings: {}, ...(params ? { params } : {}) }));
  const initial: AppState = list ? { ...config, paneState: { ...config.paneState, [id]: { ...config.paneState[id], pluginState: { "ipo-calendar": { list } } } } } : config;
  const pins: { symbol: string; options?: PinTickerOptions }[] = [];
  let update: (change: (state: AppState) => AppState) => void = () => {};
  function Harness() {
    const [state, setState] = useState(initial);
    update = setState;
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
  await tui.waitForFrameToContain(params?.search ? "ARM" : list === "listed" ? "3750" : "NXRB");
  return { pins, update };
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

test("upcoming deals and recent listings are two lists, each with its own columns", async () => {
  await mount(110, 10, undefined, null);
  const header = tui.frame().split("\n").find((line) => line.includes("COMPANY"))!;
  // Every deal here is upcoming, which the list says already: no STATUS column, and no return yet.
  expect(header).not.toContain("STATUS");
  expect(header).not.toContain("DAY 1");
  // The two lists are the bar's view, unlabelled, ahead of the search.
  expect(tui.frame()).toMatch(/Upcoming +Recent listings/);
  expect(tui.frame()).not.toContain("List");
  expect(tui.frame()).toContain("$18-20");
  expect(tui.frame()).not.toContain("3750");
});

test("IPO opens on the search the command names, on the list its deals are on, and a later request replaces it", async () => {
  const create = ipoCalendarPlugin.paneTemplates![0]!.createInstance!;
  const context = { layout: { dockRoot: null, instances: [], floating: [], detached: [] }, focusedPaneId: null } as unknown as PaneTemplateContext;
  const params = (await create(context, { arg: " arm " }))?.params;
  expect(params).toEqual({ search: "arm", tabAt: expect.stringMatching(/^\d+$/) });
  // A pane that never chose a list opens on Upcoming, and ARM listed: it moves to Recent listings.
  const { update } = await mount(110, 10, params, null);
  expect(tui.frame().split("\n").find((line) => line.includes("COMPANY"))).toContain("DAY 1");
  expect(tui.frame()).toContain("/ arm");
  expect(tui.frame()).toContain("ARM");
  expect(tui.frame()).not.toContain("3750");

  // The next request is stamped later, so it applies even when it asks for what the pane already shows.
  const asked = { ...params, search: "hk", tabAt: String(Number(params!.tabAt) + 1) };
  await act(async () => update((state) => appReducer(state, { type: "UPDATE_LAYOUT", layout: {
    ...state.config.layout, instances: state.config.layout.instances.map((instance) => ({ ...instance, params: asked })),
  } })));
  await tui.waitForFrameToContain("3750");
  expect(tui.frame()).toContain("/ hk");
  expect(tui.frame()).not.toContain("ARM");
});
