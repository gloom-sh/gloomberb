import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { AppContext, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import { attachEconCalendarPersistence, resetEconCalendarPersistence } from "./calendar-model";
import { economicCalendarModule } from "./index";

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
    <AppContext value={{ state, dispatch: () => {} }}>
      <PluginRenderProvider runtime={{} as unknown as PluginRuntimeAccess} pluginId="econ">
        <PaneInstanceProvider paneId="econ-calendar">
          <PaneFooterProvider>
            {() => (
              <EconPane paneId="econ-calendar" paneType="econ-calendar" focused width={width} height={24} />
            )}
          </PaneFooterProvider>
        </PaneInstanceProvider>
      </PluginRenderProvider>
    </AppContext>,
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
});
