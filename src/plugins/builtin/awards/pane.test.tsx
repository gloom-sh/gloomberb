import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { awardDetailCache, awardsCache } from "./client";
import { AwardsPane } from "./pane";
import { awardDetail, awardRow, awardsPayload } from "./test-fixture";

const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); awardsCache.reset(); awardDetailCache.reset(); });
async function mount(tab = "feed", width = 120, height = 26, onNavigate: (id: string, symbol?: string) => void = () => {}) {
  const persistence = new MemoryPluginPersistence();
  awardsCache.attach(persistence); awardDetailCache.attach(persistence);
  const id = "awards:test";
  const state = createInitialState(createTestPaneConfig("/tmp/awards-unit-test", { paneId: "awards", instanceId: id, settings: { tab } }));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research"
      runtime={createTestPluginRuntime({ createPaneFromTemplate: (template, options) => onNavigate(template, options?.symbol ?? options?.arg ?? undefined) })}>
      <PaneFooterProvider>{(footer) => <Box width={width} height={height} flexDirection="column">
        <Box height={height - 1}><AwardsPane paneId={id} paneType="awards" width={width} height={height - 1} focused /></Box>
        <PaneFooterBar footer={footer} width={width} focused /><PaneFooterKeys paneId={id} footer={footer} focused />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
}

test("preview retains original award evidence and keyboard navigation opens verified ticker links", async () => {
  const row = awardRow({ entity: { ...awardRow().entity!, ticker: "2330", exchange: "TWSE" } });
  setCloudApiFetchTransport(async (request) => Response.json(String(request).includes("/detail/") ? awardDetail({ row, access: "preview", locked: true }) : awardsPayload({ rows: [row], access: "preview", locked: true })));
  const navigation: Array<[string, string | undefined]> = [];
  await mount("feed", 120, 26, (id, symbol) => navigation.push([id, symbol]));
  expect(await tui.waitForFrameToContain("Contractor Corporation")).toContain("Upgrade for full awards");
  await tui.emitKeypress({ name: "g" });
  expect(navigation).toEqual([["chart-composer-pane", "2330:TWSE"]]);
  await tui.emitKeypress({ name: "return" });
  expect(await tui.waitForFrameToContain("Performance period")).toContain("2028-09-30");
  await tui.emitKeypress({ name: "escape" });
  expect(await tui.waitForFrameToContain("AWARDEE")).toContain("Contractor Corporation");
});

test("agency drilldown retains source and currency scope instead of mixing overlapping contracts", async () => {
  const requests: string[] = [];
  setCloudApiFetchTransport(async (request) => { requests.push(String(request)); return Response.json(awardsPayload()); });
  await mount("agencies");
  await tui.waitForFrameToContain("Department of Defense");
  await tui.emitKeypress({ name: "return" });
  await tui.waitForFrameToContain("Contractor Corporation");
  expect(requests.some((request) => request.includes("agency=defense") && request.includes("currency=USD") && request.includes("source=usaspending"))).toBe(true);
});

test("sector company leaders drill into the verified company's history within the selected sector", async () => {
  const requests: string[] = [];
  setCloudApiFetchTransport(async (request) => { requests.push(String(request)); return Response.json(awardsPayload()); });
  await mount("sectors");
  await tui.waitForFrameToContain("Contractor Corporation");
  await tui.emitKeypress({ name: "return" });
  await tui.waitForFrameToContain("Latest cohort");
  expect(requests.some((request) => request.includes("ticker=TEST") && request.includes("sector=Aircraft+Manufacturing") && request.includes("source=usaspending"))).toBe(true);
});
