import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { StatGrid, statGridColumns, statGridRows, type StatItem } from "./stat-grid";

const tui = createOpenTuiTestHarness({ width: 130, height: 4 });

const figures = (spot: StatItem): StatItem[] => [
  { label: "Max pain", value: "769", detail: "-0.2% vs spot" },
  spot,
  { label: "P/C OI", value: "2.27" },
  { label: "Call OI", value: "94.1k", detail: "+12,743" },
  { label: "Put OI", value: "213.4k", detail: "+22,314" },
];

test("a detail's shorter forms keep the band's columns, and the cell shows the longest that fits", async () => {
  const regular = figures({ label: "Spot", value: "770.46" });
  const stamped = figures({ label: "Spot", value: "770.46", detail: "pre-market Wed 21 Oct 11:16 UTC",
    detailVariants: ["pre-market 11:16 UTC", "pre-market", ""] });
  // A stamp that only shows outside regular hours does not move the band.
  expect(statGridColumns(stamped, 130)).toBe(statGridColumns(regular, 130));
  const unshortened = stamped.map((item) => item.label === "Spot" ? { ...item, detailVariants: undefined } : item);
  expect(statGridColumns(unshortened, 130)).toBeLessThan(statGridColumns(regular, 130));
  await tui.render(<StatGrid items={stamped} width={130} />);
  const frame = await tui.waitForFrameToContain("Spot");
  expect(frame).toContain("770.46  pre-market 11:16 UTC");
  expect(frame).not.toContain("Wed 21 Oct");
});

test("a whole-row figure too narrow for its line wraps under its value rather than cut a date, and counts its rows", async () => {
  // DDIS at 45 columns: four figures, then the newer 10-Q's row across the grid.
  const debt: StatItem[] = [
    { label: "Principal total", value: "6.17B USD", detail: "68 pctl 10Y" },
    { label: "Due next 12 months", value: "9.5%", detail: "41 pctl 10Y" },
    { label: "Due next 3 years", value: "30.4%", detail: "50 pctl 10Y" },
    { label: "As of", value: "2025-12-31" },
    { label: "Latest 10-Q", value: "Current 0 · Non-current 6.84B USD", detail: "2026-09-30 · filed 2026-10-27", wide: true },
  ];
  expect(statGridRows(debt, 45)).toBe(8);
  // Wide enough, two columns and the 10-Q on one line, as before.
  expect(statGridRows(debt, 90)).toBe(3);
  await tui.render(<StatGrid items={debt} width={45} />, { width: 45, height: 8 });
  const lines = (await tui.waitForFrameToContain("Latest 10-Q")).split("\n").map((line) => line.trimEnd());
  const at = lines.findIndex((line) => line.includes("Latest 10-Q"));
  expect(lines.slice(at, at + 4)).toEqual([
    " Latest 10-Q        Current 0",
    "                    Non-current 6.84B USD",
    "                    2026-09-30",
    "                    filed 2026-10-27",
  ]);
  expect(lines.join("\n")).not.toContain("...");

  // WIRP at 45 columns, one figure a row: a detail that does not fit beside its value takes the next line whole.
  const path: StatItem[] = [
    { label: "Next FOMC", value: "73% hike", detail: "Dec 9 · in 40 days" },
    { label: "EFFR", value: "3.88%", detail: "88 pctl 1Y · 2026-10-29" },
    { label: "Dec '26 to Jul '27", value: "+37.2bp", detail: "86 pctl 1Y" },
  ];
  expect(statGridRows(path, 45)).toBe(5);
  await tui.render(<StatGrid items={path} width={45} />, { width: 45, height: 5 });
  const frame = await tui.waitForFrameToContain("EFFR");
  expect(frame.split("\n").map((line) => line.trimEnd()).slice(0, 5)).toEqual([
    " Next FOMC          73% hike",
    "                    Dec 9 · in 40 days",
    " EFFR               3.88%",
    "                    88 pctl 1Y · 2026-10-29",
    " Dec '26 to Jul '27 +37.2bp  86 pctl 1Y",
  ]);
});
