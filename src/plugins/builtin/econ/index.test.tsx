import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
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

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

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

afterEach(async () => {
  setSystemTime();
  if (setup) {
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
  resetEconCalendarPersistence();
});

async function renderPane(width: number) {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-econ-test"));
  setup = await testRender(
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
      await setup!.renderOnce();
    }
  });
  return setup.captureCharFrame();
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
    expect(frame).toContain("NOW");
  });

  // The payload's `time` is the UTC clock; rows group by local day. The test
  // runs in whatever zone the process has, so it places the release on the far
  // side of local midnight from its UTC day: 00:30 tomorrow east of UTC, 23:30
  // today west of it. Changing process.env.TZ here would leak into later files.
  test("shows a release at its local time under its local day", async () => {
    const now = new Date();
    const eastOfUtc = now.getTimezoneOffset() <= 0;
    const at = eastOfUtc
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 30)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 30);
    const iso = at.toISOString();
    const utcClock = iso.slice(11, 16);
    const localClock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const separator = `${eastOfUtc ? "TOMORROW" : "TODAY"} · ${days[at.getDay()]} ${months[at.getMonth()]} ${at.getDate()}`;

    const persistence = new MemoryPluginPersistence();
    persistence.seedResource("calendar", "global", [{
      id: "au",
      date: iso,
      time: utcClock,
      country: "AU",
      event: "Flash Manufacturing PMI",
      impact: "medium",
      actual: null,
      forecast: null,
      prior: "52.0",
    }], { sourceKey: "gloomberb-cloud", schemaVersion: 1 });
    attachEconCalendarPersistence(persistence);
    const frame = await renderPane(110);

    expect(frame).toContain(separator);
    expect(frame).toContain(localClock);
    if (utcClock !== localClock) expect(frame).not.toContain(utcClock);
  });
});
