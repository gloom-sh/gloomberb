import { expect, test } from "bun:test";
import { researchEntryFromSearch } from "./research-entry";

test("normalizes ticker links while rejecting commands and invalid tab paths", () => {
  expect(researchEntryFromSearch("?ticker=brk.b&tab=earnings-calls")).toEqual({ symbol: "BRK.B", tab: "earnings-calls" });
  expect(researchEntryFromSearch("?ticker=NVDA&tab=../../bad")).toEqual({ symbol: "NVDA", tab: "overview" });
  for (const search of ["", "?ticker=", "?ticker=NVDA%20%3B%20rm", "?ticker=%3Cscript%3E"]) expect(researchEntryFromSearch(search)).toBeNull();
});
