/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import type { EarningsCalendarReport } from "../../../api-client/earnings";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { UiHostProvider } from "../../../ui";
import { boardReport, type BoardReport } from "./board-model";
import { EarningsCalendarView } from "./calendar";
import { calendarDays, calendarWeekDates } from "./calendar-model";

const dom = createDomTestHarness({ withUi: false });
const TODAY = "2026-10-16";
const report = (symbol: string, fields: Partial<EarningsCalendarReport> = {}): BoardReport => boardReport({
  symbol, name: `${symbol} Inc.`, date: TODAY, timing: "bmo", timingSource: "filing", reportedAt: null, fiscalPeriod: "2026-09",
  marketCap: 10e9, epsEstimate: 1, epsActual: null, epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null,
  implied: null, realized: null, averageMove: null, averageReports: 0, ...fields,
}, new Map());

function Calendar({ reports, onOpen, onMore }: { reports: BoardReport[]; onOpen: (report: BoardReport) => void; onMore: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  // 100 cells: two logos a row in each day; three rows a group, so a fourth report is counted.
  const days = calendarDays(reports, calendarWeekDates(TODAY, 0), { today: TODAY, limit: 6 });
  return (
    <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
      <WebInputHostProvider>
        <EarningsCalendarView days={days} width={100} focused selectedKey={selected}
          onSelect={(entry) => setSelected(entry.key)} onOpen={onOpen} onMore={onMore} emptyTitle="No reports." />
      </WebInputHostProvider>
    </UiHostProvider>
  );
}

const tiles = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-gloom-role=earnings-calendar-report]")];

test("the week draws each report as its logo with the ticker under it, before the open and after the close; a click selects and a second opens", async () => {
  const opened: string[] = [];
  const container = await dom.render(
    <Calendar
      onOpen={(entry) => opened.push(entry.symbol)}
      onMore={() => {}}
      reports={[
        report("JPM", { marketCap: 700e9 }),
        report("NFLX", { timing: "amc", marketCap: 400e9, epsActual: 1.2 }),
        report("WBA", { timing: "amc", marketCap: 9e9, epsActual: 0.8 }),
        report("TSLA", { date: "2026-10-14", timing: "amc" }),
      ]}
    />,
  );
  const friday = container.querySelector<HTMLElement>("[data-gloom-role=earnings-calendar-day][data-date='2026-10-16']")!;
  expect(friday.textContent).toContain("Before open");
  expect(friday.textContent).toContain("After close");
  expect(tiles(friday).map((tile) => tile.dataset.symbol)).toEqual(["JPM", "NFLX", "WBA"]);
  // Each is its logo over its ticker; the logo is the company's, with its initial behind it.
  const jpm = tiles(friday)[0]!;
  expect(jpm.querySelector("img")?.getAttribute("src")).toMatch(/\/cloud\/logos\/ticker\/JPM$/);
  expect(jpm.textContent).toContain("JPM");
  expect(jpm.getAttribute("title")).toBe("JPM · JPM Inc. · BMO · EPS est 1.00");
  // A reported company says how it did.
  expect(tiles(friday)[1]!.getAttribute("title")).toBe("NFLX · NFLX Inc. · AMC · EPS 1.20 vs 1.00 est, +20.0%");

  // The cursor starts on the week's first company, Wednesday's TSLA.
  expect(tiles(container).find((tile) => tile.dataset.selected === "true")?.dataset.symbol).toBe("TSLA");
  await act(async () => { jpm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 })); });
  expect(tiles(container).find((tile) => tile.dataset.selected === "true")?.dataset.symbol).toBe("JPM");
  expect(opened).toEqual([]);
  await act(async () => { jpm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2 })); });
  expect(opened).toEqual(["JPM"]);

  // Down moves into the after-close row, and Enter opens it, as on a table row.
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(tiles(container).find((tile) => tile.dataset.selected === "true")?.dataset.symbol).toBe("NFLX");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(opened).toEqual(["JPM", "NFLX"]);
});

test("a session with more reports than fit ends on a +N more slot that leads to the table", async () => {
  let more = 0;
  const reports = ["A", "B", "C", "D", "E", "F", "G", "H"].map((symbol, index) => report(symbol, { marketCap: (10 - index) * 1e9 }));
  const container = await dom.render(<Calendar reports={reports} onOpen={() => {}} onMore={() => { more += 1; }} />);
  expect(tiles(container).map((tile) => tile.dataset.symbol)).toEqual(["A", "B", "C", "D", "E"]);
  const slot = container.querySelector<HTMLElement>("[data-gloom-role=earnings-calendar-more]")!;
  expect(slot.textContent).toBe("+3more");
  await act(async () => { slot.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
  expect(more).toBe(1);
});
