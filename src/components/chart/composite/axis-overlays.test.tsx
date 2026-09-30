import { describe, expect, test } from "bun:test";
import { act, useState, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Box,
  UiHostProvider,
} from "../../../ui";
import type { UiHost } from "../../../ui/host";
import { WebBox } from "../../../renderers/dom/host/box";
import { WebText } from "../../../renderers/dom/host/text";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { StaticXAxisLabels } from "./axis-overlays";
import { buildCompositeViewportTimeAxisLayout } from "./time-axis";
import { noopRendererHost } from "../../../test-support/renderer-host";

function renderAxis(
  kind: "opentui" | "desktop-web",
  cursor: { cursorPixelX?: number; cursorLabel?: string } = {},
): string {
  const ui = {
    kind,
    capabilities: {
      cellWidthPx: 8,
      fractionalViewport: kind === "desktop-web",
      nativePaneChrome: kind === "desktop-web",
    },
    Box: WebBox,
    Text: WebText,
  } as unknown as UiHost;
  const fallback = "Nov 3 2025                    Mar                    Jul 29 2026";
  return renderToStaticMarkup(
    <UiHostProvider ui={ui} renderer={noopRendererHost}>
      <StaticXAxisLabels
        labels={[fallback]}
        positionedLabels={[
          { label: "Nov 3 2025", ratio: 0 },
          { label: "Mar", ratio: 0.5 },
          { label: "Jul 29 2026", ratio: 1 },
        ]}
        width={80}
        {...cursor}
      />
    </UiHostProvider>,
  );
}

describe("StaticXAxisLabels", () => {
  test("positions desktop labels by chart ratio instead of font-space advances", () => {
    const html = renderAxis("desktop-web");

    expect(html).toContain('data-gloom-role="chart-time-axis"');
    expect(html).toContain('data-gloom-label="Nov 3 2025 Mar Jul 29 2026"');
    expect(html).toContain("left:50%");
    expect(html).toContain("transform:translateX(-50%)");
    expect(html).toContain("right:0");
    // The left edge sits one cell in, on the legend's inset, off the pane border.
    expect(html).toContain("left:var(--cell-w)");
    expect(html).not.toContain("Nov 3 2025                    Mar");
  });

  test("drops a desktop tick label the cursor badge would sit on", () => {
    const html = renderAxis("desktop-web", { cursorPixelX: 80 * 8 - 1, cursorLabel: "2026-07-29" });

    expect(html).toContain(">2026-07-29<");
    expect(html).not.toContain(">Jul 29 2026<");
    expect(html).toContain(">Mar<");
  });

  test("keeps the fixed-width axis string for terminal cells", () => {
    const html = renderAxis("opentui");

    expect(html).toContain("Nov 3 2025                    Mar");
    expect(html).not.toContain("left:50%");
  });
});

type AxisProps = ComponentProps<typeof StaticXAxisLabels>;

const tui = createOpenTuiTestHarness();

/** Renders the axis in terminal cells and returns a frame reader per prop set. */
async function renderTerminalAxis(initial: AxisProps) {
  let setProps: (props: AxisProps) => void = () => {};
  function Harness() {
    const [props, setPropsState] = useState(initial);
    setProps = setPropsState;
    return <Box width={props.width} height={1}><StaticXAxisLabels {...props} /></Box>;
  }
  await tui.render(<Harness />, { width: initial.width, height: 1 });
  return async (props: AxisProps) => {
    await act(async () => { setProps(props); });
    await act(async () => { await tui.setup().renderOnce(); });
    return tui.frame().split("\n")[0]!.slice(0, props.width);
  };
}

/**
 * Every label of the bare axis either stays whole, a blank cell clear of each
 * badge, or is gone outside the badge cells; nothing touches a badge.
 */
function expectBadgesClear(
  bare: string,
  frame: string,
  labels: readonly string[],
  badges: ReadonlyArray<{ label: string; start: number }>,
) {
  const badgeCells = new Set<number>();
  for (const badge of badges) {
    expect(frame.slice(badge.start, badge.start + badge.label.length)).toBe(badge.label);
    for (let cell = badge.start; cell < badge.start + badge.label.length; cell += 1) badgeCells.add(cell);
  }
  for (const badge of badges) {
    for (const edge of [badge.start - 1, badge.start + badge.label.length]) {
      if (edge >= 0 && edge < frame.length && !badgeCells.has(edge)) expect(frame[edge]).toBe(" ");
    }
  }
  for (const label of labels) {
    const start = bare.indexOf(label);
    if (start < 0) continue;
    const end = start + label.length - 1;
    const touched = badges.some((badge) => start <= badge.start + badge.label.length && end >= badge.start - 1);
    if (!touched) {
      expect(frame.slice(start, end + 1)).toBe(label);
      continue;
    }
    for (let cell = start; cell <= end; cell += 1) {
      if (!badgeCells.has(cell)) expect(frame[cell]).toBe(" ");
    }
  }
}

function cursorBadgeStart(column: number, label: string, width: number) {
  return Math.max(0, Math.min(width - label.length, column - Math.floor(label.length / 2)));
}

describe("StaticXAxisLabels in the terminal", () => {
  test("the cursor badge blanks whole time-axis ticks it touches", async () => {
    const width = 60;
    const cursorLabel = "2025-09-26";
    for (const [start, end] of [["2022-01-01", "2026-01-31"], ["2025-01-01", "2026-01-31"]] as const) {
      const layout = buildCompositeViewportTimeAxisLayout({ start: new Date(start), end: new Date(end) }, width);
      const base: AxisProps = { labels: [layout.text], positionedLabels: layout.ticks, width };
      const frameFor = await renderTerminalAxis(base);
      const bare = await frameFor(base);
      expect(bare).toBe(layout.text.slice(0, width));
      for (let column = 0; column < width; column += 1) {
        const frame = await frameFor({ ...base, cursorColumn: column, cursorLabel });
        expectBadgesClear(bare, frame, layout.ticks.map((tick) => tick.label), [
          { label: cursorLabel, start: cursorBadgeStart(column, cursorLabel, width) },
        ]);
      }
      await tui.destroy();
    }
  });

  test("the cursor and anchor badges blank whole evenly spread labels", async () => {
    const width = 48;
    const labels = ["Jan 2024", "Jul 2024", "Jan 2025", "Jul 2025"];
    const cursorLabel = "2024-05-01";
    const anchorLabel = "2024-11-15";
    const base: AxisProps = { labels, width };
    const frameFor = await renderTerminalAxis(base);
    const bare = await frameFor(base);
    for (let column = 0; column < width; column += 1) {
      const frame = await frameFor({ ...base, cursorColumn: column, cursorLabel });
      expectBadgesClear(bare, frame, labels, [
        { label: cursorLabel, start: cursorBadgeStart(column, cursorLabel, width) },
      ]);
    }
    // An anchor badge alone, placed the way extraMarkers are.
    for (const ratio of [0, 0.2, 0.45, 0.7, 1]) {
      const frame = await frameFor({ ...base, extraMarkers: [{ ratio, label: anchorLabel, color: "#ffffff" }] });
      const start = Math.max(0, Math.min(width - anchorLabel.length, Math.round(ratio * (width - 1)) - Math.floor(anchorLabel.length / 2)));
      expectBadgesClear(bare, frame, labels, [{ label: anchorLabel, start }]);
    }
  });

  test("positioned ticks that land within a cell of each other keep a blank cell between them", async () => {
    const width = 30;
    const ticks = [
      { label: "9D", ratio: 0 },
      { label: "30D", ratio: 0.04 },
      { label: "3M", ratio: 0.12 },
      { label: "6M", ratio: 0.3 },
      { label: "1Y", ratio: 0.33 },
      { label: "2Y", ratio: 0.97 },
      { label: "3Y", ratio: 1 },
    ];
    const frameFor = await renderTerminalAxis({ labels: [], positionedLabels: ticks, width });
    const frame = await frameFor({ labels: [], positionedLabels: ticks, width });
    const words = frame.trim().split(/ +/);
    const tickLabels = ticks.map((tick) => tick.label);
    for (const word of words) expect(tickLabels).toContain(word);
    expect(frame.startsWith("9D ")).toBe(true);
    expect(frame.endsWith(" 3Y")).toBe(true);
    expect(words).toContain("6M");
  });
});
