import { expect, test } from "bun:test";
import { badgeColumnWidth, wholeBadges } from "./table-cells";

test("a key column shows the chips that fit whole and never a chip cut short", () => {
  const page = ["PageUp/PageDown", "Ctrl+Home/End"];
  // Both chips and the gap between them: 17 + 1 + 15.
  expect(badgeColumnWidth([page], { min: 8, max: 40 })).toBe(33);
  expect(wholeBadges(page, 33)).toEqual(page);
  // The 24 cells this column used to get cut the second chip to "Ctrl+Hor"; it is left out instead.
  expect(wholeBadges(page, 24)).toEqual(["PageUp/PageDown"]);
  // The first chip stays in a column narrower than itself.
  expect(wholeBadges(["Ctrl+Shift+Backspace", "Esc"], 10)).toEqual(["Ctrl+Shift+Backspace"]);
  // A short chip after one that does not fit is not shown either: a run of keys from the first.
  expect(wholeBadges(["Ctrl+Shift+Backspace", "Esc"], 25)).toEqual(["Ctrl+Shift+Backspace"]);
  expect(wholeBadges([], 10)).toEqual([]);
});
