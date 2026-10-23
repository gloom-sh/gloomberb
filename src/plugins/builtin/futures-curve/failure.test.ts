import { expect, spyOn, test } from "bun:test";
import { debugLog } from "../../../utils/debug-log";
import { loadCurveSpot } from "./client";

test("a rejected spot quote keeps the missing-basis result and logs no rejection details", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "futures-curve.client") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const spot = await loadCurveSpot("BTC-USD", {
      getQuote: async () => { throw new Error("token=private https://fixture.invalid/?secret=private"); },
    });
    expect(spot).toEqual({ symbol: "BTC-USD", price: null, asOf: null, status: "missing", reason: "no BTC-USD quote" });
    expect(logged).toEqual([["warn", "Load curve spot quote failed", undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
