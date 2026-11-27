import { expect, test } from "bun:test";
import { declaredDividendCash, declaredDividends } from "./declared-dividends";

test("a declared row stays apart from the paid history and leaves once that history lists it, even from a cached payload", () => {
  const now = new Date("2026-10-13T17:00:00Z");
  const declared = [
    { exDate: "2026-11-19", amount: 0.98, declarationDate: "2026-09-15", recordDate: "2026-11-19", payDate: "2026-12-10",
      source: { publisher: "KSEI", url: "https://example.com/cash.pdf", scheduleUrl: "https://example.com/schedule.pdf" } },
    { exDate: "2026-08-20", amount: 0.91, payDate: "2026-09-10" },
    { exDate: "2027-01-14", amount: Number.NaN },
  ];
  const actions = { dividends: [{ exDate: "2026-08-20", amount: 0.91 }], declaredDividends: declared };
  expect(declaredDividends(actions, now)).toEqual([declared[0]!]);
  // Paid a day apart by the history's own dating, or past its pay date before the history has it: no longer declared.
  expect(declaredDividends({ ...actions, dividends: [...actions.dividends, { exDate: "2026-11-20", amount: 0.98 }] }, now)).toEqual([]);
  expect(declaredDividends(actions, new Date("2026-12-11T12:00:00Z"))).toEqual([]);
  // A one-off keeps the server's mark; any other value of it is no mark.
  const special = { exDate: "2026-11-27", amount: 3.5, payDate: "2026-11-25", special: true as const };
  expect(declaredDividends({ dividends: [], declaredDividends: [special, { ...declared[0]!, special: "yes" } as never] }, now))
    .toEqual([declared[0]!, special]);
  // An older server sends no list.
  expect(declaredDividends({ dividends: actions.dividends }, now)).toEqual([]);
  const estimate = { exDate: "2026-11-05", payDate: "2026-12-17", amount: 0.075835,
    cashEstimate: { declaredCurrency: "USD", declaredAmount: 0.1, fixingDate: "2026-12-07", basis: "Reported cash estimate" } };
  const kept = declaredDividends({ dividends: [], declaredDividends: [estimate] }, new Date("2026-11-17"));
  expect(kept).toEqual([estimate]);
  const cash = declaredDividendCash(kept[0]!, "GBP");
  expect(cash.amount).toBe("$0.10 USD");
  expect(cash.estimate).toContain("GBP estimated £0.075835; FX fixing 2026-12-07");
  expect(cash.estimate).toContain("Reported cash estimate");
});
