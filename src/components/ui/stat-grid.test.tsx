import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { StatGrid, statGridColumns, type StatItem } from "./stat-grid";

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
