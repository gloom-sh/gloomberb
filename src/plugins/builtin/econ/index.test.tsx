import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { Box } from "../../../ui";
import { createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import type { PluginRuntimeAccess } from "../../runtime";
import { attachEconCalendarPersistence, resetEconCalendarPersistence } from "./calendar-model";
import { economicCalendarModule } from "./index";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { PaneInViewProvider } from "../../../state/app/activity";
import { apiClient, type CloudEconEventPayload } from "../../../api-client";

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

beforeEach(() => {
  setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
});

afterEach(() => {
  setSystemTime();
  resetEconCalendarPersistence();
});

/**
 * `impactFilter` is the filter saved with the pane; without one it opens on its default. `params` are a command's
 * (`ECO MX,BR`), `timezone` the reader's `config set timezone`.
 */
async function renderPane(width: number, impactFilter: string | null = "all", inView = true, params?: Record<string, string>, timezone?: string) {
  const config = params
    ? createTestPaneConfig("/tmp/gloomberb-econ-test", { instanceId: "econ-calendar", paneId: "econ-calendar", params })
    : createDefaultConfig("/tmp/gloomberb-econ-test");
  const state = createInitialState(timezone ? { ...config, timezone } : config);
  if (impactFilter) state.paneState["econ-calendar"] = { pluginState: { econ: { impactFilter } } };
  await tui.render(
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
    </TestPaneProvider>,
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
    expect(frame).toMatch(/No events listed after \w{3} \w{3} \d+/);
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
    const separator = `TODAY · ${days[at.getUTCDay()]} ${months[at.getUTCMonth()]} ${at.getUTCDate()}`;

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

    expect(frame).toContain("TIME (UTC)");
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
    expect(frame).toMatch(/TIME \(UTC\)\s+NEW YORK/);
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
    expect(frame).not.toContain("Core PCE");
    expect(frame).toContain("next CBRT Interest Rate Decision Sat");
    expect(frame).not.toMatch(/CBRT Interest Rate Decision in \d/);

    const quiet = await renderPane(110, "all", true, { country: "ZA", tabAt: "2" });
    expect(quiet).toContain("No scheduled releases for ZA in this window");
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
