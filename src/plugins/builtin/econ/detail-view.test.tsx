import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { DataTableStackView } from "../../../components";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { ApiRequestError } from "../../../api-client/errors";
import { attachFredSeriesPersistence, resetFredSeriesPersistence } from "../../../sources/gloomberb-cloud/fred-series";
import { outage } from "../../../test-support/outage";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
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
const answer = async () => ({
  observations,
  info: { id: "UNRATE", title: "Unemployment Rate", units: "Percent", frequency: "Monthly", seasonalAdjustment: "Seasonally Adjusted" },
}) as never;
const fredSpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(answer);
afterAll(() => fredSpy.mockRestore());

const EVENT = {
  id: "unrate", date: new Date("2026-09-04T12:30:00Z"), time: "12:30", country: "US", impact: "high",
  event: "Unemployment Rate", actual: "4.1%", forecast: "4.2%", prior: "4.2%",
} as EconEvent;

const tui = createOpenTuiTestHarness();
afterEach(() => {
  resetFredSeriesPersistence();
  fredSpy.mockImplementation(answer);
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

/** The calendar's stack with the release open: the back bar, then the detail one row shorter; `footerBar` draws the footer under it. */
async function render(width: number, height: number, event: EconEvent = EVENT, footerBar = false): Promise<string[]> {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-econ-detail-test"));
  await act(async () => {
    await tui.render(
      <TestPaneProvider state={state} paneId="econ-calendar" runtime={{} as unknown as PluginRuntimeAccess} pluginId="econ">
        <PaneFooterProvider>{(footer) => (<>
          <DataTableStackView<{ id: string }>
            focused rootWidth={width} rootHeight={height - 1} columns={[{ id: "event", label: "EVENT", width: 10, align: "left" }]} items={[{ id: "unrate" }]}
            getItemKey={(row) => row.id} renderCell={() => ({ text: "" })} selection={{ kind: "none" }} sortColumnId={null} sortDirection="asc"
            emptyStateTitle="No events" detailOpen onBack={() => {}} detailTitle={event.event}
            detailContent={<EconDetailView event={event} width={width} height={height - 1} focused />} />
          {footerBar ? <PaneFooterBar footer={footer} focused width={width} /> : null}
        </>)}</PaneFooterProvider>
      </TestPaneProvider>,
      { width, height: footerBar ? height + 1 : height },
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

test("a bank's decision says it has no stated time and why, with the prior's date and a link to the publisher's calendar", async () => {
  const decision = {
    id: "cb-cbrt-2026-10-22", date: new Date("2026-10-22T00:00:00Z"), time: "All Day", country: "TR", impact: "high",
    event: "CBRT Interest Rate Decision", actual: null, forecast: null, prior: "39.50%", priorAsOf: "2026-10-16",
    kind: "central-bank-decision", localTime: null, timeZone: "Europe/Istanbul", timeNote: "The bank's calendar gives the day, not the time",
    source: { name: "CBRT", url: "https://www.tcmb.gov.tr/" },
  } as EconEvent;
  const lines = await render(98, 12, decision);
  const text = lines.join("\n");
  expect(text).toContain("No time stated");
  expect(text).toContain("The bank's calendar gives the day, not the time");
  // The prior's date is its own figure, labelled as Central Bank Rates labels it.
  expect(text).toMatch(/Prior\s+39\.50%/);
  expect(text).toMatch(/As of\s+2026-10-16/);
  // The calendar is a named link on the last row, never a bare address.
  expect(lines.findLast((line) => line.trim())).toMatch(/^ CBRT · meeting calendar\s*$/);
  expect(text).not.toContain("tcmb.gov.tr");
  const release = {
    id: "inegi-10506", date: new Date("2026-10-22T12:00:00Z"), time: "12:00", country: "MX", impact: "high", event: "Mid-Month CPI",
    actual: null, forecast: null, prior: null, kind: "statistics-release", localTime: "06:00", timeZone: "America/Mexico_City",
    source: { name: "INEGI", url: "https://www.inegi.org.mx/app/saladeprensa/calendario" },
  } as EconEvent;
  const local = (await render(98, 12, release)).join("\n");
  expect(local).toContain("12:00 UTC");
  expect(local).toMatch(/12:00 UTC\s+06:00 Mexico City/);
  expect(local.trimEnd().split("\n").at(-1)).toMatch(/^ INEGI · release calendar\s*$/);
  expect(local).not.toContain("inegi.org.mx");
});

// The footer said "saved copy from" over a series Gloom Cloud stopped serving, after its warning.
test("a history a failed refresh left leads the footer with when it was saved; a refusal is the error", async () => {
  // What the detail saves, saved again as a copy past its refresh time.
  const fresh = new MemoryPluginPersistence();
  const saves: Array<Parameters<MemoryPluginPersistence["setResource"]>> = [];
  const setResource = fresh.setResource.bind(fresh);
  fresh.setResource = ((...args: Parameters<MemoryPluginPersistence["setResource"]>) => { saves.push(args); return setResource(...args); }) as never;
  attachFredSeriesPersistence(fresh);
  await render(98, 28, EVENT, true);
  const footer = () => tui.frame().replace(/\n+$/, "").split("\n").at(-1)!.replace(/^└\s*|┘$/g, "").trim();
  expect(footer()).not.toContain("saved copy");
  const [kind, key, value, options] = saves[0]!;
  const saved = new MemoryPluginPersistence();
  saved.seedResource(kind, key, value, { sourceKey: options.sourceKey, schemaVersion: options.schemaVersion, stale: true });
  resetFredSeriesPersistence();
  attachFredSeriesPersistence(saved);

  fredSpy.mockImplementation(async () => { throw outage(); });
  await render(98, 28, EVENT, true);
  expect(tui.frame()).toContain("● Unemployment Rate 4.10%");
  expect(footer()).toMatch(/^saved copy from \d\d:\d\d/);

  fredSpy.mockImplementation(async () => { throw new ApiRequestError("Series not found", 404); });
  await render(98, 28, EVENT, true);
  expect(tui.frame()).toContain("Series not found");
  expect(tui.frame()).not.toContain("saved copy");
});
