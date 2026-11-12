import { describe, expect, test } from "bun:test";
import { stackTabSpans } from "./header";

describe("stackTabSpans", () => {
  test("every tab shows when they fit", () => {
    expect(stackTabSpans(["Fear & Greed", "Gloom Trending"], 0, 40)).toEqual([
      { index: 0, start: 0, text: "Fear & Greed" },
      { index: 1, start: 15, text: "Gloom Trending" },
    ]);
  });

  // A focused stack's header is narrower (its frame and corner): the tab it
  // shows lost its name there, and the header named a tab it was not showing.
  test("cut to fit, the tab shown keeps its name and the others share what is left or drop out", () => {
    // Where a click lands on each: the pointer runtime reads the same spans.
    expect(stackTabSpans(["Fear & Greed", "Gloom Trending"], 1, 24)).toEqual([
      { index: 0, start: 0, text: "Fear..." },
      { index: 1, start: 10, text: "Gloom Trending" },
    ]);

    expect(stackTabSpans(["Fear & Greed", "Gloom Trending"], 0, 16)).toEqual([{ index: 0, start: 0, text: "Fear & Greed" }]);
  });
});
