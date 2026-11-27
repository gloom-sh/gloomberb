import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { PaneFooterBar, PaneFooterProvider, footerTimeText } from "../../../components/layout/pane/footer";
import { connectionHealth, GLOOM_CLOUD_HTTP_CONNECTION_ID, registerGloomCloudConnectionSources } from "../../../core/connection-health";
import { Box } from "../../../ui";
import { createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { createDefaultConfig } from "../../../types/config";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import type { PluginRuntimeAccess } from "../../runtime";
import { attachEconCalendarPersistence, getCalendarCache, resetEconCalendarPersistence } from "./calendar-model";
import { economicCalendarModule } from "./index";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { PaneInViewProvider } from "../../../state/app/activity";
import { apiClient, type CloudEconEventPayload } from "../../../api-client";
import { createRemoteUiRegistry, RemoteUiRegistryProvider, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import { renderedReportNotices } from "../../../cli/pane-functions/report-notices";

const EconPane = economicCalendarModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => React.ReactNode;

const tui = createOpenTuiTestHarness();

function seedCalendar(): void {
  const persistence = new MemoryPluginPersistence();
  const now = Date.now();
  persistence.seedResource("calendar", "global", [
    {
      id: "a",
      date: new Date(now + 3_600_000).toISOString(),
      time: "23:00",
      country: "US",
      event: "CPI m/m",
      impact: "high",
      actual: null,
      forecast: "0.3%",
      prior: "0.2%",
    },
    {
      id: "b",
      date: new Date(now - 90_000_000).toISOString(),
      time: "14:00",
      country: "FR",
      event: "Retail Sales",
      impact: "low",
      actual: "1.1%",
      forecast: "0.9%",
      prior: "0.8%",
    },
  ], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
  attachEconCalendarPersistence(persistence);
}

/** Two releases of one hour whose names differ only past their 16th letter, and one that is out with all three figures. */
function seedLongNames(): void {
  const persistence = new MemoryPluginPersistence();
  const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  persistence.seedResource("calendar", "global", [
    { id: "qoq", date: at(1), time: "13:00", country: "CA", event: "GDP Growth Rate QoQ Final", impact: "high", actual: null, forecast: "0.4%", prior: "3.3%" },
    { id: "yoy", date: at(1), time: "13:00", country: "CA", event: "GDP Growth Rate YoY Final", impact: "high", actual: null, forecast: null, prior: "0.8%" },
    { id: "out", date: at(-2), time: "10:00", country: "CN", event: "Balance of Trade", impact: "high", actual: "111.2B", forecast: "100B", prior: "105.28B" },
  ], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
  attachEconCalendarPersistence(persistence);
}

beforeEach(() => {
  setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
  spyOn(apiClient, "getCloudEconomicCalendar").mockImplementation(async () =>
    (getCalendarCache()?.data ?? []).map((event) => ({ ...event, date: event.date.toISOString() })));
});

afterEach(() => {
  setSystemTime();
  resetEconCalendarPersistence();
  (apiClient.getCloudEconomicCalendar as ReturnType<typeof spyOn>).mockRestore?.();
});

/**
 * `impactFilter` is the filter saved with the pane; without one it opens on its default. `params` are a command's
 * (`ECO MX,BR`), `timezone` the reader's `config set timezone`.
 */
async function renderPane(width: number, impactFilter: string | null = "all", inView = true, params?: Record<string, string>, timezone?: string,
  registry: RemoteUiRegistry = createRemoteUiRegistry()) {
  const config = params
    ? createTestPaneConfig("/tmp/gloomberb-econ-test", { instanceId: "econ-calendar", paneId: "econ-calendar", params })
    : createDefaultConfig("/tmp/gloomberb-econ-test");
  const state = createInitialState(timezone ? { ...config, timezone } : config);
  if (impactFilter) state.paneState["econ-calendar"] = { pluginState: { econ: { impactFilter } } };
  await tui.render(
    <RemoteUiRegistryProvider registry={registry}>
      <TestPaneProvider state={state} paneId="econ-calendar" runtime={{} as unknown as PluginRuntimeAccess} pluginId="econ">
        <PaneFooterProvider>
          {(footer) => (
            <Box width={width} height={25} flexDirection="column">
              <PaneInViewProvider value={inView}>
                <EconPane paneId="econ-calendar" paneType="econ-calendar" focused width={width} height={24} />
              </PaneInViewProvider>
              <PaneFooterBar footer={footer} width={width} focused />
            </Box>
          )}
        </PaneFooterProvider>
      </TestPaneProvider>
    </RemoteUiRegistryProvider>,
    { width, height: 25 },
  );
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
      await tui.setup().renderOnce();
    }
  });
  return tui.frame();
}

describe("EconCalendarPane", () => {
  // Most rows are low-impact releases; a newcomer should see the few that move markets.
  test("opens on high-impact events unless a filter was saved, and says so when none match", async () => {
    seedCalendar();
    const opened = await renderPane(110, null);
    expect(opened).toContain("CPI m/m");
    expect(opened).not.toContain("Retail Sales");
    // What it leaves out is counted in the footer, with the key that lists it.
    expect(opened).toContain("1 lower-impact hidden (Shift+F)");

    const saved = await renderPane(110, "all");
    expect(saved).toContain("CPI m/m");
    expect(saved).toContain("Retail Sales");
    expect(saved).not.toContain("lower-impact hidden");

    const persistence = new MemoryPluginPersistence();
    persistence.seedResource("calendar", "global", [{
      id: "low", date: new Date(Date.now() + 3_600_000).toISOString(), time: "13:00", country: "GB",
      event: "MPC Member Speaks", impact: "low", actual: null, forecast: null, prior: null,
    }], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);
    const empty = await renderPane(110, null);
    expect(empty).toContain("No high-impact events listed");
    expect(empty).toContain("Show all");
  });

  // The column math has to leave room for gaps, padding, and the scrollbar
  // lane; one column short silently clipped the last value of every row.
  test("fits the last column instead of clipping released values", async () => {
    seedCalendar();
    const frame = await renderPane(110);

    expect(frame).toContain("PRIOR");
    expect(frame).toContain("0.2%");
    expect(frame).toContain("0.8%");

    const compact = await renderPane(47, "all", true, { country: "FR" });
    expect(compact).toMatch(/ACT\s+EST\s+PRIOR/);
    expect(compact).toMatch(/Retail Sales\s+1\.1%\s+0\.9%\s+0\.8%/);
  });

  // A pane 53 cells wide (the browser's first screen) gave the name 9 cells beside three figure columns: two rows of
  // one hour both read "GDP Growt…". The names come first, as in every narrow table.
  test("keeps event names readable in a narrow pane, leaving out PRIOR and, narrower still, the forecast, and says so", async () => {
    seedLongNames();

    const firstScreen = await renderPane(53, "high");
    expect(firstScreen).toMatch(/EVENT\s+ACT\s+EST\s*\n/);
    expect(firstScreen).toContain("1 hidden · PRIOR");
    // Each row says which release it is, and its figures are whole.
    expect(firstScreen).toMatch(/GDP Growth Rate QoQ Final\s+—\s+0\.4%/);
    expect(firstScreen).toMatch(/GDP Growth Rate YoY Final\s+—\s+—/);
    expect(firstScreen).toMatch(/Balance of Trade\s+111\.2B\s+100B\s/);

    // A phone keeps the forecast a print is read against: the names give up more before it goes.
    const phone = await renderPane(48, "high");
    expect(phone).toMatch(/EVENT\s+ACT\s+EST\s*\n/);
    expect(phone).toContain("1 hidden · PRIOR");
    expect(phone).toMatch(/GDP Growth Rate QoQ\S*\s+—\s+0\.4%/);

    const narrower = await renderPane(40, "high");
    expect(narrower).toMatch(/EVENT\s+ACT\s*\n/);
    expect(narrower).toContain("2 hidden · EST, PRIOR");
    expect(narrower).toMatch(/Balance of Trade\s+111\.2B\s/);

    // With room for the names beside all three, nothing is left out.
    const wide = await renderPane(110, "high");
    expect(wide).toMatch(/ACTUAL\s+FORECAST\s+PRIOR/);
    expect(wide).not.toMatch(/\d hidden · /);
    expect(wide).toMatch(/GDP Growth Rate QoQ Final\s+—\s+0\.4%\s+3\.3%/);
  });

  // A figure column is as wide as the widest figure listed, so one trade balance weeks out (`1.522B AUD`) took the
  // forecast from every row of a phone. The long figure gives its cells back first.
  test("a long figure is cut before a phone loses the forecast of every row", async () => {
    const persistence = new MemoryPluginPersistence();
    const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
    persistence.seedResource("calendar", "global", [
      { id: "qoq", date: at(1), time: "13:00", country: "CA", event: "GDP Growth Rate QoQ Final", impact: "high", actual: null, forecast: "0.4%", prior: "3.3%" },
      { id: "out", date: at(-2), time: "10:00", country: "CN", event: "Balance of Trade", impact: "high", actual: "111.2B", forecast: "100B", prior: "105.28B" },
      { id: "aud", date: at(30), time: "18:00", country: "AU", event: "Balance of Trade", impact: "high", actual: null, forecast: "1.522B", prior: "2.826B", currency: "AUD" },
      { id: "fed", date: at(54), time: "18:00", country: "US", event: "Fed Interest Rate Decision", impact: "high", actual: null, forecast: "3.50-3.75%", prior: "3.75-4.00%" },
    ], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);

    // 45 cells here are a phone's 48 less the three its flags take.
    const phone = await renderPane(45, "high");
    expect(phone).toMatch(/EVENT\s+ACT\s+EST\s*\n/);
    expect(phone).toContain("1 hidden · PRIOR");
    // Every other row keeps its forecast whole, and the long ones say they are cut.
    expect(phone).toMatch(/GDP Growth Rat…\s+—\s+0\.4%/);
    expect(phone).toMatch(/Balance of Tra…\s+111\.2B\s+100B\s/);
    expect(phone).toMatch(/Balance of Tra…\s+—\s+1\.522B…/);
    expect(phone).toMatch(/Fed Interest R…\s+—\s+3\.50-3…/);

    // A pane whose names have their 20 cells beside the long figures cuts nothing.
    const firstScreen = await renderPane(56, "high");
    expect(firstScreen).toContain("1 hidden · PRIOR");
    expect(firstScreen).toMatch(/Balance of Trade\s+—\s+1\.522B AUD/);
    expect(firstScreen).toMatch(/Fed Interest Rate De\S*\s+—\s+3\.50-3\.75%/);

    // With room for the names beside them, long figures are whole.
    const wide = await renderPane(110, "high");
    expect(wide).toMatch(/1\.522B AUD\s+2\.826B AUD/);
    expect(wide).toMatch(/3\.50-3\.75%\s+3\.75-4\.00%/);
    expect(wide).not.toMatch(/\d hidden · /);
  });

  // Only the table drawn leaves figures out: the file has all three at any width, as it had before the names came first.
  test("Export CSV keeps every figure, whatever a narrow pane leaves out", async () => {
    seedLongNames();
    const exported = async (width: number) => {
      await renderPane(width, "high");
      await exportPaneTable("econ-calendar", "eco.csv");
      return takeSavedTextFile()!.text;
    };
    const rows = [
      "10:00,CN,Balance of Trade,111200000000,100B,105.28B",
      "13:00,CA,GDP Growth Rate QoQ Final,,0.4%,3.3%",
      "13:00,CA,GDP Growth Rate YoY Final,,,0.8%",
    ].join("\n");

    // A pane with room for all three writes the file it always wrote.
    expect(await exported(110)).toBe(`\uFEFFUTC,COUNTRY,EVENT,ACTUAL,FORECAST,PRIOR\n${rows}`);
    // One that draws ACT and EST, or ACT alone, still writes all three, under the short headers of its width.
    expect(await exported(48)).toBe(`\uFEFFUTC,CTY,EVENT,ACT,EST,PRIOR\n${rows}`);
    expect(await exported(40)).toBe(`\uFEFFUTC,CTY,EVENT,ACT,EST,PRIOR\n${rows}`);
  });

  test("shows the saved calendar's original time after a timed-out refresh and clears it on recovery", async () => {
    const persistence = new MemoryPluginPersistence();
    const entry: CloudEconEventPayload = { id: "jobs", date: "2026-08-21T13:30:00Z", time: "13:30", country: "US",
      event: "Non Farm Payrolls", impact: "high", actual: null, forecast: "93K", prior: "165K" };
    persistence.seedResource("calendar", "global", [entry], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);
    const cloud = spyOn(apiClient, "getCloudEconomicCalendar").mockRejectedValue(new DOMException("Request timed out", "TimeoutError"));
    const dispose = registerGloomCloudConnectionSources(connectionHealth);
    try {
      const offline = await renderPane(47, "high", true, { country: "US" });
      expect(offline).toContain(`saved copy from ${footerTimeText(Date.now() - 60_000)}`);
      expect(offline).toMatch(/93K\s+165K/);
      cloud.mockResolvedValue([{ ...entry, forecast: "94K" }]);
      await act(async () => {
        connectionHealth.reportReachability(GLOOM_CLOUD_HTTP_CONNECTION_ID, false);
        connectionHealth.reportReachability(GLOOM_CLOUD_HTTP_CONNECTION_ID, true);
      });
      await act(async () => { await tui.setup().renderOnce(); });
      const online = tui.frame();
      expect(online).toContain("94K");
      expect(online).not.toContain("saved copy from");
    } finally {
      dispose();
      cloud.mockRestore();
    }
  });

  test("separates days so a row's date is never ambiguous", async () => {
    seedCalendar();
    const frame = await renderPane(110);

    expect(frame).toContain("TODAY");
    expect(frame).toContain("YESTERDAY");
    // Oldest first: yesterday's release, the present, then what is still to come.
    const order = ["YESTERDAY", "Retail Sales", "NOW", "CPI m/m"].map((text) => frame.indexOf(text));
    expect(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]!))).toBe(true);
  });

  // Oldest first, a finished week would otherwise open on Monday's first release.
  test("opens on the latest release once the week's releases are all out", async () => {
    const persistence = new MemoryPluginPersistence();
    const now = Date.now();
    persistence.seedResource("calendar", "global", Array.from({ length: 40 }, (_, i) => ({
      id: `e${i}`,
      date: new Date(now - (40 - i) * 3 * 3_600_000).toISOString(),
      time: "12:00",
      country: "US",
      event: `Release ${i} m/m`,
      impact: "low",
      actual: "0.1%",
      forecast: "0.1%",
      prior: "0.1%",
    })), { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);
    const frame = await renderPane(110);

    expect(frame).toContain("Release 39 m/m");
    expect(frame).not.toContain("Release 0 m/m");
    // Nothing is listed ahead, which the footer says rather than leaving a quiet week.
    expect(frame).toMatch(/No events listed after \w{3} \d+ \w{3}/);
  });

  // NOW a few rows down would leave Friday's last releases on top of a Saturday.
  test("opens on what is still to come, never on earlier days", async () => {
    const persistence = new MemoryPluginPersistence();
    const now = Date.now();
    const release = (id: string, offsetHours: number) => ({
      id, date: new Date(now + offsetHours * 3_600_000).toISOString(), time: "12:00", country: "US",
      event: `Release ${id} m/m`, impact: "low", actual: null, forecast: "0.1%", prior: "0.1%",
    });
    persistence.seedResource("calendar", "global", [
      ...Array.from({ length: 20 }, (_, i) => release(`past${i}`, -40 + i * 0.5)),
      ...Array.from({ length: 10 }, (_, i) => release(`next${i}`, 30 + i * 24)),
    ], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);
    const frame = await renderPane(110);

    expect(frame).toContain("NOW");
    expect(frame).toContain("Release next0 m/m");
    expect(frame).not.toContain("Release past19 m/m");
    expect(frame).not.toContain("No events listed after");
  });

  // Rows group by UTC day and print the UTC clock, as `gloom econ` does,
  // whatever zone the process runs in. The release sits at 23:30 UTC, which is
  // after local midnight east of UTC; the test cannot change process.env.TZ
  // without leaking into later files, so it checks the zone it has.
  test("shows a release at its UTC time under its UTC day, with the zone in the header", async () => {
    const now = new Date();
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 30));
    const iso = at.toISOString();
    const localClock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const separator = `TODAY · ${days[at.getUTCDay()]} ${at.getUTCDate()} ${months[at.getUTCMonth()]}`;

    const persistence = new MemoryPluginPersistence();
    persistence.seedResource("calendar", "global", [{
      id: "au",
      date: iso,
      time: "23:30",
      country: "AU",
      event: "Flash Manufacturing PMI",
      impact: "medium",
      actual: null,
      forecast: null,
      prior: "52.0",
    }], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);
    const frame = await renderPane(110);

    expect(frame).toMatch(/\bUTC\s+IMPACT|\bUTC\s+IMP\b/);
    expect(frame).toContain("23:30");
    if (localClock !== "23:30") expect(frame).not.toContain(localClock);
    expect(frame).toContain(separator);
  });

  test("adds the reader's clock beside UTC when they set a time zone, where the event names keep room", async () => {
    const persistence = new MemoryPluginPersistence();
    persistence.seedResource("calendar", "global", [
      { id: "ipca", date: "2026-08-21T12:00:00.000Z", time: "12:00", country: "BR", event: "IPCA-15 Mid-Month CPI m/m",
        impact: "high", actual: "0.32%", forecast: "0.43%", prior: "0.70%" },
      // 01:30 UTC on the 22nd is still the 21st in New York.
      { id: "night", date: "2026-08-22T01:30:00.000Z", time: "01:30", country: "BR", event: "Night release",
        impact: "high", actual: null, forecast: null, prior: null },
    ], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);
    const frame = await renderPane(110, "all", true, undefined, "America/New_York");
    expect(frame).toMatch(/\bUTC\s+NEW YORK/);
    expect(frame).toMatch(/12:00\s+08:00\s+.*IPCA-15 Mid-Month CPI m\/m\s+0\.32%\s+0\.43%\s+0\.70%/);
    expect(frame).toMatch(/01:30\s+Fri 21:30\s+/);

    // A pane too narrow for it keeps the UTC time alone; a zone that is UTC all year adds nothing.
    expect(await renderPane(58, "all", true, undefined, "America/New_York")).not.toContain("NEW YORK");
    expect(await renderPane(110, "all", true, undefined, "Etc/UTC")).not.toMatch(/TIME \(UTC\)\s+UTC/);
  });

  // ECO MX,TR: the countries a command names, a bank that states no time left blank, and a country with nothing said plainly.
  test("opens on the countries a command names, with a blank time where a bank states none", async () => {
    const persistence = new MemoryPluginPersistence();
    const day = Date.UTC(2026, 7, 22);
    persistence.seedResource("calendar", "global", [
      { id: "us", date: new Date(day + 12.5 * 3_600_000).toISOString(), time: "12:30", country: "US", event: "Core PCE m/m",
        impact: "high", actual: null, forecast: null, prior: "0.2%" },
      { id: "mx", date: new Date(day + 12 * 3_600_000).toISOString(), time: "12:00", country: "MX", event: "Mid-Month CPI",
        impact: "high", actual: null, forecast: null, prior: null, kind: "statistics-release", localTime: "06:00", timeZone: "America/Mexico_City" },
      { id: "tr", date: new Date(day).toISOString(), time: "All Day", country: "TR", event: "CBRT Interest Rate Decision",
        impact: "high", actual: null, forecast: null, prior: "39.50%", kind: "central-bank-decision", localTime: null,
        timeZone: "Europe/Istanbul", timeNote: "The bank's calendar gives the day, not the time" },
    ], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);
    const frame = await renderPane(110, "all", true, { country: "MX,TR", tabAt: "1" });
    expect(frame).toContain("MX, TR");
    expect(frame).toContain("Mid-Month CPI");
    expect(frame).toMatch(/12:00\s+HIGH\s+MX\s+Mid-Month CPI/);
    expect(frame).toContain("39.50%");
    // The decision's row has no time: its line holds the flag, the country and the event, nothing in the time column.
    expect(frame.split("\n").find((line) => line.includes("CBRT Interest Rate Decision"))).not.toMatch(/\d\d:\d\d/);
    // a dash, as the CLI prints, and on the row in hand the footer says why, as the CLI does under its table.
    expect(frame.split("\n").find((line) => line.includes("CBRT Interest Rate Decision"))!.trimStart()).toStartWith("—");
    const wide = await renderPane(170, "all", true, { country: "MX,TR", tabAt: "3" });
    expect(wide).toContain("no time stated");
    // With the reader's clock beside UTC, the decision has the same dash there: no time on any clock.
    const zoned = await renderPane(140, "all", true, { country: "MX,TR", tabAt: "4" }, "America/New_York");
    expect(zoned).toMatch(/12:00\s+08:00\s+HIGH\s+MX\s+Mid-Month CPI/);
    expect(zoned).toMatch(/—\s+—\s+HIGH\s+TR\s+CBRT Interest Rate Decision/);
    expect(frame).not.toContain("Core PCE");
    expect(frame).toContain("next CBRT Interest Rate Decision Sat");
    expect(frame).not.toMatch(/CBRT Interest Rate Decision in \d/);

    const quiet = await renderPane(110, "all", true, { country: "ZA", tabAt: "2" });
    expect(quiet).toContain("No scheduled releases for ZA in this window");
  });

  // Past the listing Gloom Cloud lists each bank's next decision, marked so; the footer and the report say where the
  // releases end, as the CLI does under its table.
  test("says where the releases end when the rows shown run past it to a bank's next decision", async () => {
    const persistence = new MemoryPluginPersistence();
    persistence.seedResource("calendar", "global", [
      { id: "mx", date: "2026-08-24T12:00:00.000Z", time: "12:00", country: "MX", event: "Mid-Month CPI y/y",
        impact: "high", actual: null, forecast: null, prior: "3.42%" },
      { id: "cb-tr", date: "2026-09-17T11:00:00.000Z", time: "11:00", country: "TR", event: "CBRT Interest Rate Decision",
        impact: "high", actual: null, forecast: null, prior: "39.50%", kind: "central-bank-decision", localTime: "14:00",
        timeZone: "Europe/Istanbul", pastListing: true, listedThrough: "2026-09-04" },
    ], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);
    const registry = createRemoteUiRegistry();
    const frame = await renderPane(160, "all", true, { country: "MX,TR", tabAt: "5" }, undefined, registry);
    expect(frame).toContain("releases listed through Fri 4 Sep, then each bank's next decision");
    expect(frame).not.toContain("No events listed after");
    expect(renderedReportNotices(registry.snapshot())).toMatchObject({
      notices: expect.arrayContaining(["No releases listed after 2026-09-04; the rows after it are each central bank's next decision."]),
      facts: { releasesListedThrough: "2026-09-04" },
    });
    // Rows that stay within the listing say nothing about its end.
    const within = createRemoteUiRegistry();
    const mexico = await renderPane(160, "all", true, { country: "MX", tabAt: "6" }, undefined, within);
    expect(mexico).not.toContain("releases listed through");
    expect(renderedReportNotices(within.snapshot()).facts).not.toHaveProperty("releasesListedThrough");
  });

  test("names the Fed's rate for its upper bound, and explains a missing forecast on the row in hand", async () => {
    const day = Date.UTC(2026, 7, 21);
    const seed = (fedHour: number, fedActual: string | null) => {
      const persistence = new MemoryPluginPersistence();
      persistence.seedResource("calendar", "global", [
        { id: "fed", date: new Date(day + fedHour * 3_600_000).toISOString(), time: `${fedHour}:00`, country: "US", event: "Federal Funds Rate",
          impact: "high", actual: fedActual, forecast: "4.00%", prior: "4.00%" },
        { id: "nfp", date: new Date(day + 3 * 86_400_000 + 12.5 * 3_600_000).toISOString(), time: "12:30", country: "US",
          event: "Non Farm Payrolls", impact: "high", actual: null, forecast: null, prior: "29K" },
      ], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
      attachEconCalendarPersistence(persistence);
    };
    // It opens on the next release, the decision, whose forecast is in.
    seed(18, null);
    const decision = await renderPane(140, "all");
    expect(decision).toContain("Federal Funds Rate (upper bound)");
    expect(decision).toContain("next Federal Funds Rate (upper bound)");
    expect(decision).not.toContain("no consensus yet");
    // Once it is out, the pane opens on the payrolls, which have a prior and no forecast yet: the footer says what the dash is.
    seed(10, "4.00%");
    expect(await renderPane(140, "all")).toContain("— forecast = no consensus yet");
  });

  // A plenum or an election takes its day: "All day", never 00:00 UTC or the evening before on the reader's clock.
  test("an all-day event says All day and counts to its day", async () => {
    const persistence = new MemoryPluginPersistence();
    persistence.seedResource("calendar", "global", [
      { id: "plenum", date: "2026-08-24T00:00:00.000Z", time: "All Day", country: "CN", event: "Communist Party Fifth Plenum",
        impact: "high", actual: null, forecast: null, prior: null },
      { id: "pmi", date: "2026-08-31T01:30:00.000Z", time: "01:30", country: "CN", event: "NBS Manufacturing PMI",
        impact: "high", actual: null, forecast: null, prior: "50.1" },
    ], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);
    const frame = await renderPane(110, "all", true, undefined, "America/New_York");
    const plenum = frame.split("\n").find((line) => line.includes("Communist Party Fifth Plenum"))!;
    expect(plenum).toContain("All day");
    expect(plenum).not.toMatch(/\d\d:\d\d/);
    expect(frame).toMatch(/01:30\s+Sun 21:30\s+.*NBS Manufacturing PMI/);
    expect(frame).toContain("next Communist Party Fifth Plenum Mon");
  });

  // The pane's own refresh follows the global cadence; a print due now cannot wait for it.
  test("asks for a due high-impact print while in view with the setting off, and nothing while covered", async () => {
    const cpi: CloudEconEventPayload = {
      id: "cpi", date: new Date(Date.now() - 60_000).toISOString(), time: "11:59", country: "US",
      event: "CPI m/m", impact: "high", actual: null, forecast: "0.3%", prior: "0.2%",
    };
    const persistence = new MemoryPluginPersistence();
    persistence.seedResource("calendar", "global", [cpi], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);
    const fetches = spyOn(apiClient, "getCloudEconomicCalendar").mockResolvedValue([{ ...cpi, actual: "0.4%" }]);
    try {
      const covered = await renderPane(110, "all", false);
      expect(fetches).not.toHaveBeenCalled();
      expect(covered).not.toContain("0.4%");

      await renderPane(110);
      await tui.waitForFrameToContain("0.4%");
      expect(fetches).toHaveBeenCalledTimes(1);
    } finally {
      fetches.mockRestore();
    }
  });
});
