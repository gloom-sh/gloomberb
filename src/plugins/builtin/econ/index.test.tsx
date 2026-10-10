import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import type { PluginRuntimeAccess } from "../../runtime";
import { attachEconCalendarPersistence, resetEconCalendarPersistence } from "./calendar-model";
import { economicCalendarModule } from "./index";
import { TestPaneProvider } from "../../../test-support/pane";

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

async function renderPane(width: number) {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-econ-test"));
  await tui.render(
    <TestPaneProvider state={state} paneId="econ-calendar" runtime={{} as unknown as PluginRuntimeAccess} pluginId="econ">
      <PaneFooterProvider>
        {() => (
          <EconPane paneId="econ-calendar" paneType="econ-calendar" focused width={width} height={24} />
        )}
      </PaneFooterProvider>
    </TestPaneProvider>,
    { width, height: 24 },
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
  });

  // Rows group by UTC day and print the UTC clock, as `gloomberb econ` does,
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
});
