import { afterEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { setCloudApiFetchTransport } from "../../../../api-client";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { mnaDealCache, mnaDealsCache } from "../client";
import { MnaPane } from "../pane";
import { DISTRESS_CACHES } from "./client";
import { filingEvent, goingConcernRow, insolvencyPage, placeholderFilingEvent } from "./test-fixture";

const tui = createOpenTuiTestHarness();
const PANE = "mna:test";

afterEach(() => {
  setCloudApiFetchTransport(null);
  mnaDealsCache.reset();
  mnaDealCache.reset();
  for (const cache of DISTRESS_CACHES) cache.reset();
});

const DEALS = { deals: [], hasMore: false, nextOffset: 0, access: "full", delayDays: 0, lockedDeals: 0, asOf: "2026-10-06T00:00:00Z" };

/** Serves every route the pane reads; `answers` overrides by path. */
function serve(answers: Record<string, unknown> = {}) {
  const requests: string[] = [];
  setCloudApiFetchTransport(async (input) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    const route = Object.keys(answers).find((path) => url.pathname.endsWith(path));
    if (route) return Response.json(answers[route]);
    if (url.pathname.endsWith("/cloud/mna/deals")) return Response.json(DEALS);
    if (url.pathname.endsWith("/public/events")) return Response.json({ events: [filingEvent(), placeholderFilingEvent()] });
    if (url.pathname.endsWith("/public/going-concern")) return Response.json({ disclosures: [goingConcernRow()], hasMore: false, limit: 100, offset: 0 });
    return Response.json(insolvencyPage([]));
  });
  return requests;
}

async function mount(params?: Record<string, string>) {
  for (const cache of [mnaDealsCache, mnaDealCache, ...DISTRESS_CACHES]) cache.attach(new MemoryPluginPersistence());
  const config = createTestPaneConfig(":memory:", { instanceId: PANE, paneId: "mna", ...(params ? { params } : {}) });
  config.refreshIntervalMinutes = 0;
  const pins: string[] = [];
  const runtime = createTestPluginRuntime({ pinTicker: (symbol) => { pins.push(symbol); } });
  const stateRef: { current: AppState | null } = { current: null };
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, config, createInitialState);
    stateRef.current = state;
    return (
      <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE} pluginId="ticker-research" runtime={runtime} width={130} height={14} footerKeys>
        {(body) => <MnaPane paneId={PANE} paneType="mna" focused {...body} />}
      </TestPaneFrame>
    );
  }
  await act(async () => { await tui.render(<Harness />, { width: 130, height: 14 }); });
  return { pins, stateRef };
}

const press = (name: string) => tui.emitKeypress({ name, sequence: name });

test("MA opens on its deals with a Distress tab beside them, and the tab is kept with the pane", async () => {
  const requests = serve();
  const { stateRef } = await mount();
  await tui.waitForFrameToContain("Deals  Distress");
  expect(requests.some((request) => request.startsWith("/cloud/mna/deals"))).toBe(true);
  expect(requests.some((request) => request.startsWith("/public/"))).toBe(false);

  await press("l");
  await tui.waitForFrameToContain("Leslie's, Inc.");
  expect(requests).toContain("/public/events?kind=distress&limit=200");
  expect(JSON.stringify(stateRef.current?.paneState[PANE])).toContain("\"tab\":\"distress\"");
});

test("DIST opens the pane on the Distress tab without reading the deals", async () => {
  const requests = serve();
  await mount({ tab: "distress" });
  await tui.waitForFrameToContain("Leslie's, Inc.");
  expect(requests.some((request) => request.startsWith("/cloud/mna/deals"))).toBe(false);
});

test("a filer with a trading symbol opens it; one known only by its CIK offers no ticker", async () => {
  serve();
  const { pins } = await mount({ tab: "distress" });
  await tui.waitForFrameToContain("[t]icker");
  await press("t");
  expect(pins).toEqual(["LESL"]);

  await press("down");
  await tui.waitForFrameToExclude("[t]icker");
  await press("t");
  expect(pins).toEqual(["LESL"]);
});

test("the arrows move between sources; an unreadable answer is an error, an empty one is not a finding", async () => {
  const requests = serve({ "/public/going-concern": { disclosures: [goingConcernRow({ verdict: "likely_to_fail" })], hasMore: false, limit: 100, offset: 0 } });
  await mount({ tab: "distress" });
  await tui.waitForFrameToContain("Leslie's, Inc.");

  await press("right");
  await tui.waitForFrameToContain("unreadable going-concern disclosures");
  expect(requests).toContain("/public/going-concern?verdict=doubt_raised&limit=100");

  await press("right");
  await press("right");
  await tui.waitForFrameToContain("No notices.");
  expect(tui.frame()).toContain("A company missing here may still be in insolvency proceedings.");
});
