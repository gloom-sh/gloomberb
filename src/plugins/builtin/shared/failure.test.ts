import { expect, spyOn, test } from "bun:test";
import { debugLog } from "../../../utils/debug-log";
import { cachedCloudResource } from "./cloud-resource";

test("a cached payload that no longer validates seeds nothing and logs no payload details", () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "shared.cloud-resource") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const cache = {
      get: () => ({ data: { account: "private" }, fetchedAt: 0, stale: true, source: "cache" as const }),
      load: async () => { throw new Error("unused"); },
    };
    const resource = cachedCloudResource(cache, "fixture", () => { throw new Error("token=private account=private"); });
    expect(resource).toBeNull();
    expect(logged).toEqual([["warn", expect.stringMatching(/^Validate cached cloud payload failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
