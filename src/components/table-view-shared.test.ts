import { describe, expect, test } from "bun:test";
import { isTableScrollNearEnd } from "./table-view-shared";

describe("isTableScrollNearEnd", () => {
  test("is false until the remaining scroll is within the threshold", () => {
    const scrollBox = { scrollTop: 0, scrollHeight: 40, viewport: { height: 20 } };
    expect(isTableScrollNearEnd(scrollBox, 8)).toBe(false);
    scrollBox.scrollTop = 12;
    expect(isTableScrollNearEnd(scrollBox, 8)).toBe(true);
  });
});
