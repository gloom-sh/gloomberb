import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { DataTableStackView } from "../../../components";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { resetFredSeriesPersistence } from "../../../sources/gloomberb-cloud/fred-series";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider } from "../../../test-support/pane";
import { createDefaultConfig } from "../../../types/config";
import type { PluginRuntimeAccess } from "../../runtime";
import { EconDetailView } from "./detail-view";
import type { EconEvent } from "./types";

// Two years of a monthly unemployment rate, oldest first, ending at 4.1%.
const rates = [3.7, 3.8, 3.9, 3.9, 3.8, 3.9, 4.0, 4.1, 4.3, 4.2, 4.1, 4.1, 4.2, 4.1, 4.0, 4.1, 4.1, 4.2, 4.2, 4.3, 4.2, 4.4, 4.2, 4.1];
const observations = rates.map((value, index) => ({
  date: new Date(Date.UTC(2024, 8 + index, 1)).toISOString().slice(0, 10), value,
}));
const fredSpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async () => ({
  observations,
  info: { id: "UNRATE", title: "Unemployment Rate", units: "Percent", frequency: "Monthly", seasonalAdjustment: "Seasonally Adjusted" },
}) as never);
afterAll(() => fredSpy.mockRestore());

const EVENT = {
  id: "unrate", date: new Date("2026-09-04T12:30:00Z"), time: "12:30", country: "US", impact: "high",
  event: "Unemployment Rate", actual: "4.1%", forecast: "4.2%", prior: "4.2%",
} as EconEvent;

const tui = createOpenTuiTestHarness();
afterEach(() => {
  resetFredSeriesPersistence();
});

/** Paints outside act: resolving the related tickers keeps work queued that act would wait on. */
async function paint(delayMs = 30) {
  for (let index = 0; index < 4; index += 1) {
    await Bun.sleep(delayMs);
    await tui.setup().renderOnce();
  }
}

/** A key press, painted outside act for the same reason. */
async function press(name: string) {
  tui.setup().renderer.keyInput.emit("keypress", {
    name, ctrl: false, alt: false, meta: false, option: false, shift: false, eventType: "press", repeated: false,
    preventDefault() {}, stopPropagation() {},
  } as never);
  await paint(60);
}

/** The calendar's stack with the release open: the back bar, then the detail one row shorter. */
async function render(width: number, height: number): Promise<string[]> {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-econ-detail-test"));
  await act(async () => {
    await tui.render(
      <TestPaneProvider state={state} paneId="econ-calendar" runtime={{} as unknown as PluginRuntimeAccess} pluginId="econ">
        <PaneFooterProvider>{() => (
          <DataTableStackView<{ id: string }>
            focused rootWidth={width} rootHeight={height - 1} columns={[{ id: "event", label: "EVENT", width: 10 }]} items={[{ id: "unrate" }]}
            getItemKey={(row) => row.id} renderCell={() => ({ text: "" })} selection={{ kind: "none" }} sortColumnId={null} sortDirection="asc"
            detailOpen onBack={() => {}} detailTitle={EVENT.event}
            detailContent={<EconDetailView event={EVENT} width={width} height={height - 1} focused />} />
        )}</PaneFooterProvider>
      </TestPaneProvider>,
      { width, height },
    );
  });
  await paint();
  return tui.frame().split("\n");
}

test("the FRED history charts over its revised periods, named like the table, with each period's move", async () => {
  const lines = await render(98, 28);
  expect(lines[1]).toMatch(/Actual\s+4\.1%\s+Forecast\s+4\.2%/);
  expect(lines.some((line) => line.includes("● Unemployment Rate 4.10%"))).toBe(true);
  const header = lines.findIndex((line) => line.includes("UNEMPLOYMENT RATE"));
  expect(lines[header]).toMatch(/PERIOD\s+UNEMPLOYMENT RATE\s+CHG/);
  // Axis ticks in percent between the legend and the table.
  expect(lines.slice(0, header).some((line) => /\d\.\d+%\s*$/.test(line))).toBe(true);
  expect(lines[header + 1]).toMatch(/2026-08-01\s+4\.10%\s+-0\.10pp/);
  // A move that rounds to nothing is unsigned.
  expect(lines.some((line) => /2026-07-01\s+4\.20%\s+-0\.20pp/.test(line))).toBe(true);
  expect(lines.some((line) => /\s0\.00pp/.test(line))).toBe(true);
  expect(lines.join("\n")).not.toContain("+0.00pp");
  expect(lines.join("\n")).toContain("Related:");
});

test("the selected period is the chart's cursor", async () => {
  await render(98, 28);
  await press("down");
  expect(tui.frame()).toContain("● Unemployment Rate 4.20%");
  await press("left");
  expect(tui.frame()).toContain("● Unemployment Rate 4.40%");
});

test("a short detail keeps the history rows and draws the chart as a strip", async () => {
  const lines = await render(40, 10);
  const header = lines.findIndex((line) => line.includes("PERIOD"));
  expect(lines[header - 1]).toMatch(/^ ● Unemployment Rate [⠀-⣿]+ 4\.10%/);
  expect(lines.slice(header + 1).filter((line) => /\d{4}-\d{2}-\d{2}/.test(line)).length).toBeGreaterThanOrEqual(4);
});
