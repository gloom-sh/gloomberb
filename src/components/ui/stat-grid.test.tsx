import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { displayWidth } from "../../utils/format";
import { StatGrid, statGridColumns, statGridRows, statGridWithin, type StatItem } from "./stat-grid";

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

const lines = (frame: string) => frame.split("\n").map((line) => line.trimEnd());

test("a whole-row figure too narrow for its line takes a second for its detail, cut where it has no date, and counts its rows", async () => {
  // DDIS at 45 columns: four figures, then the newer 10-Q's row across the grid.
  const debt: StatItem[] = [
    { label: "Principal total", value: "6.17B USD", detail: "68 pctl 10Y" },
    { label: "Due next 12 months", value: "9.5%", detail: "41 pctl 10Y" },
    { label: "Due next 3 years", value: "30.4%", detail: "50 pctl 10Y" },
    { label: "As of", value: "2025-12-31" },
    { label: "10-Q 2026-09-30", value: "Current 0 · Non-current 6.84B USD", detail: "filed 2026-10-27", detailVariants: [""], wide: true },
  ];
  // Wide enough, two columns and the 10-Q on one line.
  expect(statGridRows(debt, 90)).toBe(3);
  // The figures wider than their column take both lines, as the pane lets the filed date go (the footer says it).
  expect(statGridRows(debt, 45)).toBe(6);
  await tui.render(<StatGrid items={debt} width={45} />, { width: 45, height: 6 });
  const ddis = lines(await tui.waitForFrameToContain("10-Q"));
  expect(ddis.slice(4, 6)).toEqual([
    " 10-Q 2026-09-30    Current 0",
    "                    Non-current 6.84B USD",
  ]);
  // With a dated detail and no shorter form, the value is what gives way, and the date is not.
  const dated = [...debt.slice(0, 4), { ...debt[4]!, detailVariants: undefined }];
  await tui.render(<StatGrid items={dated} width={45} />, { width: 45, height: 6 });
  expect(lines(await tui.waitForFrameToContain("filed")).slice(4, 6)).toEqual([
    " 10-Q 2026-09-30    Current 0 · Non-current…",
    "                    filed 2026-10-27",
  ]);

  // WIRP in a 45-column window (43 inside its border), one figure a row: a detail that does not fit beside
  // its value takes the next line, and a percentile gives way to the date it shares that line with.
  const path: StatItem[] = [
    { label: "Next FOMC", value: "73% hike", detail: "Dec 9 · in 40 days" },
    { label: "EFFR", value: "3.88%", detail: "88 pctl 1Y · 2026-10-29" },
    { label: "Dec '26 to Jul '27", value: "+37.2bp", detail: "86 pctl 1Y" },
  ];
  expect(statGridRows(path, 43)).toBe(5);
  // Within four lines, only the leading figure wraps; the rest keep one line, cut.
  expect(statGridRows(path, 43, undefined, { maxLines: 4 })).toBe(4);
  // A band of three lines keeps the three figures a line each, not two rows that take four.
  expect(statGridWithin(path, 43, 3)).toEqual({ items: path, lines: 3 });
  expect(statGridWithin(path, 43, 2)).toEqual({ items: path.slice(0, 2), lines: 2 });
  await tui.render(<StatGrid items={path} width={43} />, { width: 43, height: 5 });
  expect(lines(await tui.waitForFrameToContain("EFFR")).slice(0, 5)).toEqual([
    " Next FOMC          73% hike",
    "                    Dec 9 · in 40 days",
    " EFFR               3.88%",
    "                    88 pctl… · 2026-10-29",
    " Dec '26 to Jul '27 +37.2bp  86 pctl 1Y",
  ]);
});

test("a wrapped figure keeps its split bar on the first line, and a wide label pads by cells", async () => {
  const split = (buy: number, hold: number, sell: number) => [
    { id: "buy", value: buy, color: "#00ff00" }, { id: "hold", value: hold, color: "#888888" }, { id: "sell", value: sell, color: "#ff0000" },
  ];
  const narrow: StatItem[] = [
    // Options positioning's open interest: the bar stays beside the value, the change wraps under it.
    { label: "Open interest", value: "1.24M", detail: "+12,743", split: split(7, 0, 5) },
    // Analyst ratings wider than the column: the mix on two lines, the bar after the first.
    { label: "Ratings", value: "9 Buy · 5 Hold · 1 Sell", split: split(9, 5, 1) },
    { label: "目标价", value: "250.00" },
  ];
  expect(statGridRows(narrow, 36)).toBe(5);
  await tui.render(<StatGrid items={narrow} width={36} />, { width: 36, height: 5 });
  const frame = lines(await tui.waitForFrameToContain("Ratings"));
  expect(frame[0]).toMatch(/^ Open interest +1\.24M █{12}$/u);
  expect(frame[1]).toBe("               +12,743");
  expect(frame[2]).toMatch(/^ Ratings +9 Buy · 5 Hold █{5}$/u);
  expect(frame[3]).toBe("               1 Sell");
  // Two cells a character, so the value starts in the same column as the others.
  const column = (line: string, text: string) => displayWidth(line.slice(0, line.indexOf(text)));
  expect(column(frame[4]!, "250.00")).toBe(column(frame[0]!, "1.24M"));
});
