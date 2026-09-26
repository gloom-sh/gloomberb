import { expect, test } from "bun:test";
import { shouldPersistSelection } from "./series-list-detail";

const knownIds = ["buffett", "shiller-cape", "tobins-q"];

test.each([
  // The row a deferred keyboard commit resolves to is real, but the user never chose it.
  { case: "a filter moved the rows under a pending keyboard commit", id: "tobins-q", reason: "keyboard", selectionOnScreen: false, persist: false },
  { case: "an explicit click while the selection is filtered away", id: "shiller-cape", reason: "pointer", selectionOnScreen: false, persist: true },
  { case: "ordinary keyboard movement", id: "shiller-cape", reason: "keyboard", selectionOnScreen: true, persist: true },
  { case: "an id that is not in the list", id: "nonsense", reason: "pointer", selectionOnScreen: true, persist: false },
] as const)("selection persists for $case: $persist", ({ id, reason, selectionOnScreen, persist }) => {
  expect(shouldPersistSelection({ id, reason, selectionOnScreen, knownIds })).toBe(persist);
});
