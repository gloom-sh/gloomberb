import { expect, spyOn, test } from "bun:test";
import { debugLog } from "../../../utils/debug-log";
import { loadListedOpenInterest } from "./open-interest-as-of";

test("a listing that cannot be read leaves the open-interest date unstated and logs no rejection details", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "options.open-interest-as-of") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const listed = await loadListedOpenInterest("ACME", "2026-11-20", {
      api: { optionsPositioning: async () => { throw new Error("token=private https://fixture.invalid/?secret=private"); } },
    });
    expect(listed).toBeNull();
    expect(logged).toEqual([["warn", expect.stringMatching(/^Load listed open interest failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
