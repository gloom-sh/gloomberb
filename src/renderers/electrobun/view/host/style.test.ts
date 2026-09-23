import { expect, test } from "bun:test";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../input-host";
import { commonStyle } from "./style";

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
