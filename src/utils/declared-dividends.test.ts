import { expect, test } from "bun:test";
import { declaredDividends } from "./declared-dividends";

test("a declared row stays apart from the paid history and leaves once that history lists it, even from a cached payload", () => {
  const now = new Date("2026-10-13T17:00:00Z");
  const declared = [
    { exDate: "2026-11-19", amount: 0.98, declarationDate: "2026-09-15", recordDate: "2026-11-19", payDate: "2026-12-10" },
    { exDate: "2026-08-20", amount: 0.91, payDate: "2026-09-10" },
    { exDate: "2027-01-14", amount: Number.NaN },
  ];
  const actions = { dividends: [{ exDate: "2026-08-20", amount: 0.91 }], declaredDividends: declared };
  expect(declaredDividends(actions, now)).toEqual([declared[0]!]);
  // Paid a day apart by the history's own dating, or past its pay date before the history has it: no longer declared.
  expect(declaredDividends({ ...actions, dividends: [...actions.dividends, { exDate: "2026-11-20", amount: 0.98 }] }, now)).toEqual([]);
  expect(declaredDividends(actions, new Date("2026-12-11T12:00:00Z"))).toEqual([]);
  // An older server sends no list.
  expect(declaredDividends({ dividends: actions.dividends }, now)).toEqual([]);
});
