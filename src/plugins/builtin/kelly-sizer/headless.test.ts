import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { kellyHeadless } from "./headless";

afterEach(() => setSystemTime());

/** Daily closes whose 21-session returns, counted back from the last close, are `returns` in order. */
function closes(returns: readonly number[]) {
  const start = Date.parse("2026-01-01T00:00:00Z");
  let close = 100;
  const points = [{ date: new Date(start), close }];
  returns.forEach((value) => {
    for (let day = 1; day <= 21; day += 1) {
      if (day === 21) close *= 1 + value;
      points.push({ date: new Date(start + points.length * 86_400_000), close });
    }
  });
  return points;
}

async function notes(returns: readonly number[]) {
  const history = closes(returns);
  setSystemTime(new Date(history.at(-1)!.date.getTime() + 86_400_000));
  const result = await kellyHeadless.load(
    createTestHeadlessArgs({ symbols: ["BTC-USD"], options: { years: 1 } }),
    createTestHeadlessContext({
      resolveInstrument: async () => ({ symbol: "BTC-USD", exchange: "" }),
      marketData: createTestDataProvider({ getPriceHistoryForResolution: async () => history, getPriceHistory: async () => history }),
    }),
  );
  return result.notes ?? [];
}

test("a Kelly fraction over the whole bankroll is said to be leverage, and one inside it says nothing of it", async () => {
  // Gains of 20% five months in nine against 15% losses: full Kelly sizes past the bankroll, half inside it.
  const levered = (await notes([0.2, -0.15, 0.2, -0.15, 0.2, -0.15, 0.2, -0.15, 0.2])).find((note) => note.startsWith("Over 100%"));
  expect(levered).toMatch(/^Over 100% of bankroll means leverage, borrowing or margin beyond what you hold: Full Kelly 1\d\d\.\d\d% is 1\.\d\dx the bankroll\.$/);
  // Gains of 30% against losses of 25%, five months in nine: full Kelly stays inside the bankroll.
  expect((await notes([0.3, -0.25, 0.3, -0.25, 0.3, -0.25, 0.3, -0.25, 0.3])).join(" ")).not.toContain("leverage");
});
