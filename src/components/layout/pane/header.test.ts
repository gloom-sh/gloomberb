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
  // A tab with no room left went with no trace, so a count stands for it.
  test("cut to fit, the tab shown keeps its name, the others share what is left, and a count stands for the rest", () => {
    // Where a click lands on each: the pointer runtime reads the same spans.
    expect(stackTabSpans(["Fear & Greed", "Gloom Trending"], 1, 24)).toEqual([
      { index: 0, start: 0, text: "Fear &…" },
      { index: 1, start: 10, text: "Gloom Trending" },
    ]);

    expect(stackTabSpans(["Fear & Greed", "Gloom Trending"], 0, 16)).toEqual([
      { index: 0, start: 0, text: "Fear & Greed" },
      { index: 1, start: 13, text: "+1", more: true },
    ]);

    // Four tabs, room for one more beside the one shown: the count presses
    // through the rest, the first after the one shown, then on round.
    const titles = ["News", "Chart", "Quotes", "Fear & Greed"];
    const spans = stackTabSpans(titles, 1, 20);
    expect(spans).toEqual([
      { index: 0, start: 0, text: "News" },
      { index: 1, start: 7, text: "Chart" },
      { index: 2, start: 13, text: "+2", more: true },
    ]);
    expect(stackTabSpans(titles, 2, 20).at(-1)).toEqual({ index: 3, start: 14, text: "+2", more: true });
    expect(stackTabSpans(titles, 3, 20).at(-1)).toEqual({ index: 0, start: 13, text: "+3", more: true });
  });

  test("with no room for the count beside a letter of the name shown, the name goes alone", () => {
    expect(stackTabSpans(["Fear & Greed", "Gloom Trending"], 0, 5)).toEqual([{ index: 0, start: 0, text: "Fear…" }]);
  });
});
