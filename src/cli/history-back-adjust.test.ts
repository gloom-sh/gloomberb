import { expect, test } from "bun:test";
import { backAdjustHistory, stitchedRollsNote, type ContractCloses } from "./history-back-adjust";

// ES=F over two quarterly rolls: September's into December on 2026-09-11, December's into March on 2026-12-11.
// The source still serves ESU26 on its roll day; ESZ26 has expired by the time it is asked, so the March contract's
// close on the bar before that roll stands in.
const bar = (date: string, close: number, contract?: string, roll?: true) =>
  ({ date, open: close - 1, high: close + 2, low: close - 3, close, contract, ...roll ? { roll } : {} });
const rows = [
  bar("2026-09-09", 6500),
  bar("2026-09-10", 6510, "ESU26"),
  bar("2026-09-11", 6580, "ESZ26", true),
  bar("2026-12-10", 6700, "ESZ26"),
  bar("2026-12-11", 6770, "ESH27", true),
  bar("2026-12-14", 6790, "ESH27"),
];
const closes: Record<string, ContractCloses> = {
  ESU26: new Map([["2026-09-11", 6520]]),
  ESH27: new Map([["2026-12-10", 6765]]),
};

test("back-adjusting stitches each roll by the gap between the two contracts that day, newest prices as traded", () => {
  const { rows: adjusted, rolls } = backAdjustHistory(rows, "difference", (contract) => closes[contract]);
  // December over September on the 11th: +60. March over December on the 10th, the bar before its roll: +65.
  expect(rolls.map((roll) => [roll.from, roll.to, roll.on, roll.adjustment])).toEqual([
    ["ESU26", "ESZ26", "2026-09-11", 60], ["ESZ26", "ESH27", "2026-12-10", 65]]);
  expect(adjusted.map((row) => row.close)).toEqual([6625, 6635, 6645, 6765, 6770, 6790]);
  // Every price of a bar moves, not only its close; the bar a roll is read on keeps its own contract.
  expect(adjusted[0]).toMatchObject({ open: 6624, high: 6627, low: 6622 });
  expect(adjusted.at(-1)).toBe(rows.at(-1)!);
  expect(stitchedRollsNote("ES=F", "difference", rolls, "2026-09-10")).toBe("ES=F back-adjusted by difference at 2 rolls: "
    + "ESU26 to ESZ26 on 2026-09-11 (+60); ESZ26 to ESH27 on 2026-12-11 (+65, read on 2026-12-10). Every price before a roll is moved by "
    + "the gap between the two contracts that day; the newest contract's prices are as traded. Bars before 2026-09-10 name no contract, "
    + "so a roll before then is left as traded.");
});

test("by ratio the gaps compound as factors, and a roll neither contract prices is left as traded, named, the later ones still stitched", () => {
  const { rows: adjusted } = backAdjustHistory(rows, "ratio", (contract) => closes[contract]);
  expect(adjusted[3]!.close).toBeCloseTo(6765, 6);
  expect(adjusted[1]!.close).toBeCloseTo(6510 * (6580 / 6520) * (6765 / 6700), 4);
  // The source serves no bars of ESU26: September's roll keeps its gap, December's is closed.
  const partial = backAdjustHistory(rows, "difference", (contract) => contract === "ESU26" ? undefined : closes[contract]);
  expect(partial.rolls.map((roll) => roll.to)).toEqual(["ESH27"]);
  expect(partial.unstitched).toEqual([{ date: "2026-09-11", from: "ESU26", to: "ESZ26" }]);
  expect(partial.rows.map((row) => row.close)).toEqual([6565, 6575, 6645, 6765, 6770, 6790]);
  expect(stitchedRollsNote("ES=F", "difference", partial.rolls, null, partial.unstitched, new Set(["ESU26"]))).toBe("ES=F back-adjusted by difference "
    + "at its roll: ESZ26 to ESH27 on 2026-12-11 (+65, read on 2026-12-10). Every price before a roll is moved by the gap between the two "
    + "contracts that day; the newest contract's prices are as traded. ESU26 to ESZ26 on 2026-09-11 is left as traded: the source served no bars of ESU26.");
  const none = backAdjustHistory(rows, "difference", () => undefined);
  expect(none.rows).toEqual(rows);
  expect(stitchedRollsNote("ES=F", "difference", none.rolls, null, none.unstitched)).toBe("ES=F is not back-adjusted. ESU26 to ESZ26 on 2026-09-11 "
    + "is left as traded: neither contract has a close on 2026-09-11 or the bar before. ESZ26 to ESH27 on 2026-12-11 is left as traded: neither "
    + "contract has a close on 2026-12-11 or the bar before.");
});
