import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { CreditDocumentsPayload } from "../../../api-client/credit-documents";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { creditCache } from "./client";
import fixture from "./fico.fixture.json";
import { CreditDocumentsPane } from "./pane";
const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); creditCache.reset(); });
async function mount(width: number, height: number, tab = "capital", payload = structuredClone(fixture) as CreditDocumentsPayload, settings: { instrument?: string; view?: string; fact?: string } = {}) {
  creditCache.attach(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async (url) => {
    const path = String(url);
    if (path.includes("/instruments/")) return Response.json(payload.instruments.find((row) => path.endsWith(row.id)));
    if (path.includes("/screen")) return Response.json({ rows: [], access: "full", lockedRows: 0, asOf: "2026-10-04T12:00:00.000Z", truncated: false });
    return Response.json(payload);
  });
  const id = "credit-documents:test";
  const state = createInitialState(createTestPaneConfig("/tmp/credit-pane-test", { paneId: "credit-documents", instanceId: id, binding: { kind: "fixed", symbol: "FICO" }, settings: { tab, ...settings } }));
  state.tickers.set("FICO", createTestTicker("FICO", "Fair Isaac Corporation"));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      <PaneFooterProvider>{(footer) => <Box width={width} height={height} flexDirection="column">
        <Box height={height - 1}><CreditDocumentsPane paneId={id} paneType="credit-documents" width={width} height={height - 1} focused /></Box>
        <PaneFooterBar footer={footer} width={width} focused /><PaneFooterKeys paneId={id} footer={footer} focused />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
}

test("keyboard opens current terms and literal evidence, then returns through both stacks", async () => {
  await mount(128, 30);
  await tui.waitForFrameToContain("Revolving line of credit");
  await tui.renderFrames(2);
  await tui.emitKeypress({ name: "return" });
  await tui.waitForFrameToContain("DISCLOSED VALUE");
  await tui.emitKeypress({ name: "return" });
  const evidence = await tui.waitForFrameToContain("Evidence span");
  expect(evidence).toContain("Open filing");
  expect(evidence).toContain("On May 13, 2025");
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("DISCLOSED VALUE");
  await tui.emitKeypress({ name: "escape" });
  expect(await tui.waitForFrameToContain("INSTRUMENT")).toContain("Revolving line of credit");
});

test("narrow preview preserves visible amounts and offers the standard upgrade", async () => {
  const preview = structuredClone(fixture) as CreditDocumentsPayload;
  preview.access = "preview"; preview.lockedRows = 5;
  await mount(80, 20, "capital", preview);
  const frame = await tui.waitForFrameToContain("Upgrade to see all terms");
  expect(frame).toContain("400M");
  expect(frame).not.toContain("provider:");
});

test("amendment evidence distinguishes a pending revision and its effective date", async () => {
  const data = structuredClone(fixture) as CreditDocumentsPayload;
  const instrument = data.instruments[0]!;
  const pending = { ...instrument.facts[0]!, id: "pending-amendment", status: "pending" as const, effectiveDate: "2027-01-01" };
  instrument.history = [...instrument.facts, pending];
  await mount(128, 30, "capital", data, { instrument: instrument.id, view: "history", fact: pending.id });
  const frame = await tui.waitForFrameToContain("Not yet in effect");
  expect(frame).toContain("Pending");
  expect(frame).toContain("2027-01-01");
});

test("uncomputable covenants and an empty current screen never invent a ratio or a signal", async () => {
  await mount(128, 30, "covenants");
  const frame = await tui.waitForFrameToContain("Uncomputable");
  expect(frame).toContain("HEADROOM");
  expect(frame).not.toContain("0.0%");
  await tui.emitKeypress({ name: "return" });
  expect(await tui.waitForFrameToContain("definition")).toContain("definition");
  await tui.destroy();
  await mount(80, 20, "screen");
  expect(await tui.waitForFrameToContain("No supported credit signals")).toContain("Headroom below");
});
