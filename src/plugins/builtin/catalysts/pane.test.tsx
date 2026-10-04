import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { catalystCache, catalystDetailCache } from "./client";
import { CatalystsPane } from "./pane";
import { catalystFixture, catalystPayload } from "./test-fixture";

const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); catalystCache.reset(); catalystDetailCache.reset(); });
test("default filters load once, compact rows preserve date precision, and Enter opens the matching evidence", async () => {
  catalystCache.attach(new MemoryPluginPersistence()); catalystDetailCache.attach(new MemoryPluginPersistence());
  let calls = 0;
  setCloudApiFetchTransport(async (url) => {
    calls++;
    return Response.json(String(url).includes("/events/") ? { event: catalystFixture, history: [catalystFixture], asOf: catalystFixture.observedAt } : catalystPayload());
  });
  const paneId = "catalysts:test";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-catl-test", { paneId: "catalysts", instanceId: paneId, binding: { kind: "none" } }));
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneFrame state={current} dispatch={dispatch} paneId={paneId} pluginId="ticker-research" runtime={runtime} width={90} height={20} footerKeys>{(body) => <CatalystsPane paneId={paneId} paneType="catalysts" {...body} focused />}</TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 90, height: 20 }); });
  const frame = await tui.waitForFrameToContain("Primary completion");
  expect(frame).toContain("2027-04");
  expect(frame).toContain("Deadline");
  await tui.renderFrames(6);
  expect(calls).toBe(1);
  await tui.emitKeypress({ name: "return" });
  expect(await tui.waitForFrameToContain("Confidence")).toContain("Confidence");
  expect(tui.frame()).toContain("Evidence");
  expect(calls).toBe(2);
});

test("an alert opens its exact event even when it is absent from the calendar page", async () => {
  catalystCache.attach(new MemoryPluginPersistence()); catalystDetailCache.attach(new MemoryPluginPersistence());
  const requested: string[] = [];
  setCloudApiFetchTransport(async (url) => {
    requested.push(String(url));
    return Response.json(String(url).includes("/events/") ? { event: catalystFixture, history: [catalystFixture], asOf: catalystFixture.observedAt } : { ...catalystPayload(), events: [], total: 0 });
  });
  const paneId = "catalysts:alert-test";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-catl-alert-test", { paneId: "catalysts", instanceId: paneId, binding: { kind: "none" }, settings: { open: catalystFixture.id } }));
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneFrame state={current} dispatch={dispatch} paneId={paneId} pluginId="ticker-research" runtime={runtime} width={90} height={20} footerKeys>{(body) => <CatalystsPane paneId={paneId} paneType="catalysts" {...body} focused />}</TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 90, height: 20 }); });
  expect(await tui.waitForFrameToContain("Confidence")).toContain("Evidence");
  expect(requested.filter((url) => url.includes(`/events/${catalystFixture.id}`))).toHaveLength(1);
  await tui.emitKeypress({ name: "escape", sequence: "\u001b" });
  expect(await tui.waitForFrameToContain("No events match")).toContain("No events match");
});
