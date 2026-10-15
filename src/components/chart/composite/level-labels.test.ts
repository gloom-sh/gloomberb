import { expect, test } from "bun:test";
import { contrastRatio } from "../../../theme/color-utils";
import { layoutLevelLabels, levelLabelStyle, levelLabelText } from "./level-labels";
import type { ProjectedLevel } from "./levels";

const level = (id: string, yRatio: number, color = "#00cc66"): ProjectedLevel => ({
  yRatio, level: { id, value: 10, label: id, color, editable: false, actionable: false },
});

test("tags centre on their line and yield when their text would clip or overlap", () => {
  for (const height of [90, 347.5, 720]) {
    for (const textHeight of [18, 24]) {
      const [middle] = layoutLevelLabels([level("middle", 0.5)], height, textHeight);
      expect(middle!.top + textHeight / 2).toBeCloseTo(height * 0.5);
      expect(layoutLevelLabels([level("top", 0), level("bottom", 1)], height, textHeight)).toEqual([]);
    }
  }
  expect(layoutLevelLabels([level("first", 0.5), level("near", 0.6), level("clear", 0.8)], 100, 18).map(({ level }) => level.id)).toEqual(["first", "clear"]);
});

test("price survives in the tag when its precise axis marker cannot be shown", () => {
  const entry = { ...level("Buy 10 working", 0.5).level, axisLabel: "10.25" };
  expect(levelLabelText(entry, true)).toBe("Buy 10 working");
  expect(levelLabelText(entry, false)).toBe("Buy 10 working 10.25");
  expect(levelLabelText({ ...entry, axisLabel: undefined }, false)).toBe("Buy 10 working");
});

test("DOM tags fit their text with an opaque fill and a one-pixel semantic border", () => {
  for (const [background, color] of [["#000000", "#00cc66"], ["#272822", "#f92672"], ["#000000", "#808080"]]) {
    const style = levelLabelStyle(level("label", 0.5, color), background!);
    expect(style.top).toBe("50%");
    expect(style.transform).toBe("translateY(-50%)");
    expect(style.border).toBe(`1px solid ${color}`);
    expect(style.backgroundColor).toBe(background);
    expect(style.width).toBe("max-content");
    expect(style.height).toBe("auto");
    expect(contrastRatio(style.color!, background!)).toBeGreaterThanOrEqual(4.5);
  }
});
