import { expect, test } from "bun:test";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { commonStyle } from "./style";

test("a divider stays one edge, including transitions from and back to a full frame", () => {
  const edge = commonStyle({ border: ["left", "bottom"], borderColor: "#00cc66" });
  expect(edge.borderWidth).toBe("0px 0px 1px 1px");
  expect(edge.borderColor).toBe("#00cc66");
  expect(commonStyle({ border: ["top"] }).borderWidth).toBe("1px 0px 0px 0px");
  expect(commonStyle({ border: [] }).borderWidth).toBe("0px 0px 0px 0px");
  expect(commonStyle({ border: true }).borderWidth).toBe("1px");
  expect(commonStyle({ border: false }).borderWidth).toBeUndefined();
});

test("maps axis gaps in cells and never emits an unset longhand that would clear gap", () => {
  const wrapped = commonStyle({ flexDirection: "row", flexWrap: "wrap", columnGap: 2, rowGap: 0 });
  expect(wrapped.columnGap).toBe(`${2 * WEB_CELL_WIDTH}px`);
  expect(wrapped.rowGap).toBe("0px");

  // React writes an undefined style key as "", which resets the longhand `gap` just set.
  const stacked = commonStyle({ flexDirection: "column", gap: 1 });
  expect(stacked.gap).toBe(`${WEB_CELL_HEIGHT}px`);
  expect("rowGap" in stacked).toBe(false);
  expect("columnGap" in stacked).toBe(false);
});
