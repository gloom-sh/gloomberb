/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import type { SeriesAxisTag } from "./panel-labels";
import { placeSeriesAxisTags, SeriesAxisTags } from "./series-axis-tags";

const { render } = createDomTestHarness();

const tag = (seriesId: string, side: "left" | "right", overrides: Partial<SeriesAxisTag> = {}): SeriesAxisTag => ({
  seriesId, seriesLabel: seriesId, side, value: -7797, label: "-7,797", color: "rgb(1, 2, 3)", yRatio: 0.5, carried: false, ...overrides,
});

test("a value on the axis sits in a box in its series colour, so the tick beside it cannot read as the value's sign", async () => {
  const placed = placeSeriesAxisTags([tag("live", "right"), tag("carried", "right", { yRatio: 0.9, carried: true, label: "6,360" })], 200, 18);
  const container = await render(<SeriesAxisTags placed={placed} pixelHeight={200} lanes={1} background="rgb(9, 9, 9)" />);
  const boxes = new Map([...container.querySelectorAll("[data-gloom-role=chart-series-axis-tag]")].map((node) => [(node as HTMLElement).dataset.seriesId!, node as HTMLElement]));

  expect(boxes.get("live")!.style.border).toBe("1px solid rgb(1, 2, 3)");
  expect(boxes.get("live")!.textContent).toBe("-7,797");
  // A value carried from an earlier date keeps its dashes, now all round the box.
  expect(boxes.get("carried")!.style.border).toBe("1px dashed rgb(1, 2, 3)");
});
