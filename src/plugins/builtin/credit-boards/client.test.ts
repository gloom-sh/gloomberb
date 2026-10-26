import { expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { loadCurrencyMoves } from "./client";

/** Daily closes for the last sixty days up to yesterday, rising so the month's move is not zero. */
function risingHistory(): PricePoint[] {
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  return Array.from({ length: 60 }, (_, index) => ({ date: new Date(today - (60 - index) * 86_400_000), close: 1 + index * 0.001 }));
}

test("a failed history read is unknown for every caller waiting on it and is asked again next time", async () => {
  let asked = 0;
  let failing = true;
  const loadHistory = async () => {
    asked += 1;
    await Promise.resolve();
    if (failing) throw new Error("feed down");
    return risingHistory();
  };

  // Two panes open together: the second joins the first's read and must not see the rejection.
  const [first, second] = await Promise.all([loadCurrencyMoves(["CHF"], loadHistory), loadCurrencyMoves(["CHF"], loadHistory)]);
  expect([...first]).toEqual([["CHF", null]]);
  expect([...second]).toEqual([["CHF", null]]);
  expect(asked).toBe(1);

  failing = false;
  const retried = await loadCurrencyMoves(["CHF"], loadHistory);
  expect(asked).toBe(2);
  expect(typeof retried.get("CHF")).toBe("number");
  await loadCurrencyMoves(["CHF"], loadHistory);
  expect(asked).toBe(2);
});
