import { expect, test } from "bun:test";
import { contrastRatio } from "../../../theme/color-utils";
import { layoutLevelLabels, levelLabelStyle } from "./level-labels";
import type { ProjectedLevel } from "./levels";

const level = (id: string, yRatio: number, color = "#00cc66"): ProjectedLevel => ({
  yRatio, level: { id, value: 10, label: id, color, editable: false, actionable: false },
});

test("annotations clear their SVG line by three pixels, flipping only at the top edge", () => {
  for (const height of [90, 347.5, 720]) {
    for (const textHeight of [18, 24]) {
      const [middle] = layoutLevelLabels([level("middle", 0.5)], height, textHeight);
      expect(middle!.below).toBe(false);
      expect(middle!.top + textHeight).toBeCloseTo(height * 0.5 - 3);
      expect(levelLabelStyle(middle!, "#000000").top).toBe("50%");
      expect(levelLabelStyle(middle!, "#000000").transform).toBe("translateY(calc(-100% - 3px))");
      const [top] = layoutLevelLabels([level("top", 0)], height, textHeight);
      expect(top!.below).toBe(true);
      expect(top!.top).toBe(3);
      expect(levelLabelStyle(top!, "#000000").transform).toBe("translateY(3px)");
      const [bottom] = layoutLevelLabels([level("bottom", 1)], height, textHeight);
      expect(bottom!.top + textHeight).toBe(height - 3);
    }
  }
});

test("flipped labels participate in the existing priority policy at their actual text position", () => {
  // Lines 25px apart clear the old row policy, but the flipped label and the
  // above-line label land at 3px and 4px. Keep the first, not overlapping text.
  const levels = [level("top", 0), level("near", 0.25), level("clear", 0.7)];
  expect(layoutLevelLabels(levels, 100, 18).map(({ level }) => level.id)).toEqual(["top", "clear"]);
  expect(layoutLevelLabels(levels, 15, 18)).toEqual([]);
});

test("the label halo is an opaque two-pixel background stroke behind AA-contrast semantic text", () => {
  for (const [background, color] of [["#000000", "#00cc66"], ["#272822", "#f92672"], ["#000000", "#808080"]]) {
    const entry = { ...level("label", 0.5, color), below: false };
    const style = levelLabelStyle(entry, background!);
    expect(style.WebkitTextStroke).toBe(`2px ${background}`);
    expect(style.paintOrder).toBe("stroke fill");
    expect(style.backgroundColor).toBeUndefined();
    expect(contrastRatio(style.color!, background!)).toBeGreaterThanOrEqual(4.5);
  }
  expect(levelLabelStyle({ ...level("buy", 0.5), below: false }, "#000000").color).toBe("#00cc66");
});
