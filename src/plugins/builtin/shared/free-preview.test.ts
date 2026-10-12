import { expect, test } from "bun:test";
import { isProLock } from "../../../cli/pane-functions/access-gate";
import { countOf, freePreviewNote, previewCantFilter } from "./free-preview";

test("a free preview says what free shows, what Pro adds and where its history starts", () => {
  const note = freePreviewNote({ shows: "3 of 6 KPI values", adds: "the other 3", historyFrom: "2024-09-30T00:00:00Z" });
  expect(note).toBe("Free shows 3 of 6 KPI values. Gloom Pro adds the other 3, with history from 30 Sep 2024.");
  // Reports print it under "Pro" and a bot-safe check calls it a lock, as the bare lines were.
  expect(isProLock(note)).toBe(true);
});

test("a clause the response cannot back is left out, not guessed", () => {
  expect(freePreviewNote({ shows: "3 relationships per role" })).toBe("Free shows 3 relationships per role. Gloom Pro adds the rest.");
  expect(freePreviewNote({ shows: "3 awards", adds: " ", historyFrom: null })).toBe("Free shows 3 awards. Gloom Pro adds the rest.");
  for (const historyFrom of ["", "soon", "2024-02-30", "2024-13-01"]) {
    expect(freePreviewNote({ shows: "3 awards", adds: "every award", historyFrom })).toBe("Free shows 3 awards. Gloom Pro adds every award.");
  }
});

test("counts and ignored filters read as a sentence", () => {
  expect([countOf(0, "earnings call"), countOf(1, "award"), countOf(1_384, "award")]).toEqual(["no earnings calls", "1 award", "1,384 awards"]);
  expect(countOf(2, "guidance figure", "guidance figures")).toBe("2 guidance figures");
  expect(previewCantFilter(["ticker"])).toBe("the preview can't filter by ticker");
  expect(previewCantFilter(["ticker", "date", "date", "country"])).toBe("the preview can't filter by ticker, date or country");
  expect(previewCantFilter([])).toBe("the preview can't filter");
});
