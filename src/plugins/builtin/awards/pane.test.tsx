import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { MISSING_VALUE } from "../../../utils/format";
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

test("unreported amounts leave the feed, not its export, and any reported amount restores its column", async () => {
  const missing = awardRow({ awardAmount: null, obligatedAmount: null, ceilingAmount: null, revenueComparison: null });
  let rows = [missing];
  setCloudApiFetchTransport(async () => Response.json(awardsPayload({ rows })));
  await mount("feed", 240, 26);
  const empty = await tui.waitForFrameToContain("Contractor Corporation");
  expect(empty).not.toMatch(/VALUE|OBLIGATED|CEILING/);
  await exportPaneTable("awards:test", "awards.csv");
  const [header, record] = takeSavedTextFile()!.text.trim().split("\n").map((line) => line.split(","));
  // The query's one currency heads the amounts; the export keeps its column too.
  expect(header).toContain("CCY");
  for (const label of ["Value USD", "Obligated USD", "Ceiling USD"]) {
    expect(header).toContain(label);
    expect(record![header!.indexOf(label)]).toBe("");
  }
  await tui.destroy();
  awardsCache.reset();
  rows = [missing, awardRow({ id: "reported", recipient: { name: "Reported contractor" }, awardAmount: "0", obligatedAmount: "2500000", ceilingAmount: "0" })];
  await mount("feed", 240, 26);
  const populated = await tui.waitForFrameToContain("Reported contractor");
  expect(populated).toMatch(/VALUE USD\s+OBLIGATED USD\s+CEILING USD/);
  expect(populated.split("\n").find((line) => line.includes("Reported contractor"))).toMatch(/\s0\s+2\.50M\s+0/);
  expect(populated.split("\n").find((line) => line.includes("Contractor Corporation"))).toMatch(new RegExp(`\\s${MISSING_VALUE}\\s+${MISSING_VALUE}\\s+${MISSING_VALUE}`));
  await exportPaneTable("awards:test", "awards.csv");
  expect(takeSavedTextFile()!.text).toContain("USD,0,2500000,0");
});

test("a mixed-source feed hides the obligation and ceiling its newest notices lack until scrolled to awards that report them", async () => {
  const notices = Array.from({ length: 30 }, (_, index) => awardRow({ id: `notice-${index}`, source: "contracts-finder", jurisdiction: "GB", currency: "GBP",
    recipient: { name: `Notice supplier ${index}` }, awardDate: "2026-11-13", awardAmount: "56612", obligatedAmount: null, ceilingAmount: null, entity: null, revenueComparison: null }));
  const prime = awardRow({ id: "prime", recipient: { name: "Prime contractor" }, awardDate: "2026-11-12", awardAmount: null, obligatedAmount: "112.52", ceilingAmount: "150" });
  setCloudApiFetchTransport(async () => Response.json(awardsPayload({ rows: [...notices, prime] })));
  await mount("feed", 240, 26);
  await tui.waitForFrameToContain("Notice supplier 0", 40);
  // The table opens on every loaded row, then measures the rows in view.
  const top = await tui.waitForFrameToExclude("OBLIGATED", 40);
  expect(top).toContain("Notice supplier 0");
  expect(top).toContain("VALUE");
  expect(top).not.toContain("CEILING");
  await act(async () => { await tui.emitKeypress({ name: "end" }); });
  await tui.waitForFrameToContain("Prime contractor", 40);
  // Scrolling measures the new rows in view after the frame that drew them.
  const bottom = await tui.waitForFrameToContain("OBLIGATED", 40);
  expect(bottom).toMatch(/VALUE\s+OBLIGATED\s+CEILING/);
  expect(bottom.split("\n").find((line) => line.includes("Prime contractor"))).toMatch(new RegExp(`USD\\s+${MISSING_VALUE}\\s+112\\.52\\s+150`));
  await exportPaneTable("awards:test", "awards.csv");
  const csv = takeSavedTextFile()!.text;
  expect(csv).toContain("GBP,56612,,");
  expect(csv).toContain("USD,,112.52,150");
});

test("a withheld amount alone keeps Value visible without reviving unavailable amounts", async () => {
  setCloudApiFetchTransport(async () => Response.json(awardsPayload({ rows: [awardRow({ awardAmount: null, obligatedAmount: null, ceilingAmount: null, amountWithheld: "under S$6,000", revenueComparison: null })] })));
  await mount("feed", 240, 26);
  const frame = await tui.waitForFrameToContain("withheld");
  expect(frame).toContain("VALUE");
  expect(frame).not.toMatch(/OBLIGATED|CEILING/);
});

test("events decide Compared value from the revenue comparison, not the award face value", async () => {
  let alerts = [awardRow({ revenueComparison: null })];
  setCloudApiFetchTransport(async () => Response.json(awardsPayload({ alerts })));
  await mount("events", 240, 26);
  expect(await tui.waitForFrameToContain("Contractor Corporation")).not.toContain("COMPARED VALUE");
  await tui.destroy();
  awardsCache.reset();
  alerts = [...alerts, awardRow({ id: "compared", awardAmount: null, recipient: { name: "Compared contractor" }, revenueComparison: { ...awardRow().revenueComparison!, awardAmount: "2500000" } })];
  await mount("events", 240, 26);
  const frame = await tui.waitForFrameToContain("Compared contractor");
  expect(frame).toContain("COMPARED VALUE");
  expect(frame.split("\n").find((line) => line.includes("Compared contractor"))).toContain("2.50M");
  expect(frame.split("\n").find((line) => line.includes("Contractor Corporation"))).toMatch(new RegExp(`USD\\s+${MISSING_VALUE}`));
});

for (const tab of ["agencies", "sectors"]) test(`${tab} omit unavailable amounts despite section rows and keep a reported zero`, async () => {
  const payload = awardsPayload();
  for (const row of [...payload.agencies, ...payload.leaders]) Object.assign(row, { awardAmount: null, obligatedAmount: null, ceilingAmount: null });
  setCloudApiFetchTransport(async () => Response.json(payload));
  await mount(tab, 240, 26);
  const label = tab === "agencies" ? "Department of Defense" : "Contractor Corporation";
  expect(await tui.waitForFrameToContain(label)).not.toMatch(/VALUE|OBLIGATED|CEILING/);
  await tui.destroy();
  awardsCache.reset();
  for (const row of [...payload.agencies, ...payload.leaders]) row.awardAmount = "0";
  await mount(tab, 240, 26);
  const frame = await tui.waitForFrameToContain(label);
  expect(frame).toContain("VALUE");
  expect(frame).not.toMatch(/OBLIGATED|CEILING/);
});

test("preview retains original award evidence and keyboard navigation opens verified ticker links", async () => {
  const row = awardRow({ entity: { ...awardRow().entity!, ticker: "2330", exchange: "TWSE" } });
  setCloudApiFetchTransport(async (request) => Response.json(String(request).includes("/detail/") ? awardDetail({ row, access: "preview", locked: true }) : awardsPayload({ rows: [row], access: "preview", locked: true })));
  const navigation: Array<[string, string | undefined]> = [];
  await mount("feed", 120, 26, (id, symbol) => navigation.push([id, symbol]));
  expect(await tui.waitForFrameToContain("Contractor Corporation")).toContain("Upgrade for full awards");
  await tui.emitKeypress({ name: "g" });
  expect(navigation).toEqual([["chart-composer-pane", "2330:TWSE"]]);
  await tui.emitKeypress({ name: "return" });
  expect(await tui.waitForFrameToContain("Performance period")).toContain("30 Sep 2028");
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
