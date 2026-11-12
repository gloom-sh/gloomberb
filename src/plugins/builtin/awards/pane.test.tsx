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

test("empty company selection cannot open an unrelated feed award or issuer", async () => {
  setCloudApiFetchTransport(async () => Response.json(awardsPayload()));
  const navigation: string[] = [];
  await mount("company", 120, 26, (id) => navigation.push(id));
  const frame = await tui.waitForFrameToContain("Enter a company ticker.");
  expect(frame).not.toContain("[o]pen source");
  await tui.emitKeypress({ name: "e" });
  await tui.emitKeypress({ name: "d" });
  expect(navigation).toEqual([]);
  expect(tui.frame()).toContain("Enter a company ticker.");
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

test("a source's licence statement shows under its awards, and nowhere else", async () => {
  const notice = "Contains information from Government Procurement via GeBIZ accessed on 12 November 2026 from data.gov.sg which is made available under the terms of the Singapore Open Data Licence version 1.0 https://data.gov.sg/open-data-licence";
  const source = { source: "sg-gebiz", enabled: true, lastAttemptAt: null, lastOkAt: "2026-11-12T09:00:00Z", nextPollAt: null, failures: 0, lastError: null, cursor: null,
    coverageStart: "2021-04-01", coverageEnd: "2026-03-31", coverageComplete: true, records: 246, requestsToday: 0, attribution: notice,
    amountNotice: "An amount under S$6,000, or one that two or more suppliers of a tender print alike, is shown as no amount." };
  // GeBIZ withholds this award's amount: it reads withheld, never 0 or unreported.
  const gebiz = awardRow({ id: "award-sg", source: "sg-gebiz", jurisdiction: "SG", currency: "SGD", title: "Maintenance for Network Uninterruptible Power Supply (UPS)", awardAmount: null, amountWithheld: "printed alike for 4 suppliers of the tender",
    recipient: { name: "NCS PTE. LTD." }, agency: { name: "Central Provident Fund Board" }, sourceUrl: "https://data.gov.sg/api/action/datastore_search?resource_id=d_acde1106003906a75c3fa052592f2fcb",
    entity: { ...awardRow().entity!, ticker: "Z74", exchange: "SGX", legalName: "NCS PTE. LTD." }, revenueComparison: null });
  // One GeBIZ never printed an amount for reads unreported, never withheld.
  const unprinted = awardRow({ id: "award-sg-blank", source: "sg-gebiz", jurisdiction: "SG", currency: "SGD", title: "Canteen services", awardAmount: null,
    recipient: { name: "SATS FOOD SERVICES PTE. LTD." }, revenueComparison: null });
  let rows = [gebiz, unprinted, awardRow()];
  setCloudApiFetchTransport(async () => Response.json(awardsPayload({ rows, sources: [source] })));
  await mount("feed", 200, 30);
  const feed = await tui.waitForFrameToContain("NCS PTE. LTD.");
  expect(feed).toContain("Contains information from Government Procurement via GeBIZ");
  expect(feed.split("\n").find((line) => line.includes("NCS PTE. LTD."))).toMatch(/SGD\s+withheld/);
  expect(feed.split("\n").find((line) => line.includes("SATS FOOD SERVICES"))).not.toContain("withheld");
  // The award's own evidence carries it too, and says how a withheld amount reads.
  await tui.emitKeypress({ name: "return" });
  const detail = await tui.waitForFrameToContain("Observed (UTC)");
  expect(detail).toContain("Contains information from Government Procurement via GeBIZ");
  expect(detail).toContain("withheld");
  expect(detail).toContain("is shown as no amount");
  expect(detail).toContain("printed alike for 4 suppliers of the tender");
  // Awards from sources that ask for nothing show nothing new.
  awardsCache.reset();
  rows = [awardRow()];
  await mount("feed", 120, 30);
  expect(await tui.waitForFrameToContain("Contractor Corporation")).not.toContain("Contains information");
});
