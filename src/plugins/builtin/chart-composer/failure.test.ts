import { expect, spyOn, test } from "bun:test";
import { debugLog } from "../../../utils/debug-log";
import { loadDailyObjectives } from "./leverage-overlay";

test("a rejected fund fact read keeps the other objectives and logs no rejection details", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "chart-composer.leverage-overlay") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const objectives = await loadDailyObjectives(["TQQQ", "SQQQ"], async (ticker) => {
      if (ticker === "TQQQ") throw new Error("token=private https://fixture.invalid/?secret=private");
      return { leverage: { value: -3, reset: "daily", proxy: { ticker: "QQQ" } } };
    });
    expect([...objectives]).toEqual([["SQQQ", { factor: -3, proxy: "QQQ" }]]);
    expect(logged).toEqual([["warn", expect.stringMatching(/^Load chart fund objective failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
