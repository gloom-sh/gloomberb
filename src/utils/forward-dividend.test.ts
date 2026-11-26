import { expect, test } from "bun:test";
import { forwardDividendBasis, forwardDividendNote, lapsedDividend, lapseValue, lastPaidNote, monthlyHistoryEnd, noCurrentDividend } from "./forward-dividend";

test("a forward rate is never as of a day that has not come: an ex-date ahead names the declared distribution", () => {
  const now = new Date("2026-10-13T17:00:00Z");
  // The latest distribution's ex-date has passed, today included.
  expect(forwardDividendBasis("2026-08-20", { now })).toBe("latest distribution annualized, as of 2026-08-20");
  expect(forwardDividendBasis("2026-10-13", { now, payDate: "2026-11-05" })).toBe("latest distribution annualized, as of 2026-10-13");
  // MSFT once its next quarter is declared: Gloom Cloud dates the rate by the coming ex-date.
  expect(forwardDividendBasis("2026-11-19", { now, payDate: new Date("2026-12-10T00:00:00Z") }))
    .toBe("annualized from the declared distribution payable 2026-12-10, ex 2026-11-19");
  expect(forwardDividendBasis("2026-11-19", { now })).toBe("annualized from the declared distribution, ex 2026-11-19");
  expect(forwardDividendBasis(null, { now })).toBe("latest distribution annualized");
  expect([forwardDividendNote("2026-08-20", { now }), forwardDividendNote("2026-11-19", { now })]).toEqual(["as of 2026-08-20", "declared"]);
});

test("the declared amount is named only from a row stated for the rate's own ex-date, never divided back from the rate", () => {
  const now = new Date("2026-10-13T17:00:00Z");
  const declared = [{ exDate: "2026-11-19", amount: 0.98, declarationDate: "2026-09-15", payDate: "2026-12-10" }];
  expect(forwardDividendBasis("2026-11-19", { now, declared, currency: "USD" }))
    .toBe("annualized from the declared $0.98 payable 2026-12-10, ex 2026-11-19");
  expect(forwardDividendNote("2026-11-19", { now, declared, currency: "USD" })).toBe("declared $0.98");
  // A row for another ex-date, or an amount without its currency, is not this rate's distribution: dates only.
  expect(forwardDividendBasis("2026-11-20", { now, declared, currency: "USD" })).toBe("annualized from the declared distribution, ex 2026-11-20");
  expect(forwardDividendBasis("2026-11-19", { now, declared })).toBe("annualized from the declared distribution, ex 2026-11-19");
  // Once it has gone ex the rate is the latest distribution's again.
  expect(forwardDividendBasis("2026-11-19", { now: new Date("2026-11-20T15:00:00Z"), declared, currency: "USD" }))
    .toBe("latest distribution annualized, as of 2026-11-19");
});

test("a dividend lapses past its own usual interval plus grace, read from the issuer's recent ex-dates", () => {
  const at = (day: string) => new Date(`${day}T15:00:00Z`);
  // WHR: quarterly until 2026-02-27, the second quarter declared at nothing.
  const quarterly = ["2025-02-28", "2025-05-16", "2025-08-29", "2025-11-21", "2026-02-27"];
  expect(lapsedDividend("2026-02-27", { exDates: quarterly }, at("2026-10-16"))).toEqual({ lastPaid: "2026-02-27" });
  // A quarter and half a quarter: current through day 136, stopped from day 137.
  expect(lapsedDividend("2026-02-27", { exDates: quarterly }, at("2026-07-13"))).toBeNull();
  expect(lapsedDividend("2026-02-27", { exDates: quarterly }, at("2026-07-14"))).toEqual({ lastPaid: "2026-02-27" });
  // A special distribution between two quarters does not make the payer monthly.
  expect(lapsedDividend("2026-02-27", { exDates: [...quarterly, "2026-01-05"] }, at("2026-07-13"))).toBeNull();
  // Nor does one beside the only regular distribution: with two dates the window is at least a quarter's,
  // so the dividend is current until its next regular ex-date is a quarter and a half late.
  expect(lapsedDividend("2026-02-27", { exDates: ["2026-02-27", "2026-03-20"] }, at("2026-05-29"))).toBeNull();
  expect(lapsedDividend("2026-02-27", { exDates: ["2026-02-27", "2026-03-20"] }, at("2026-08-03"))).toBeNull();
  expect(lapsedDividend("2026-02-27", { exDates: ["2026-02-27", "2026-03-20"] }, at("2026-08-04"))).toEqual({ lastPaid: "2026-03-20" });
  // Monthly: day 40 is current, and from day 41 the history ends rather than the dividend stopped (monthlyHistoryEnd).
  const monthly = ["2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"];
  expect(lapsedDividend("2026-09-30", { exDates: monthly }, at("2026-11-09"))).toBeNull();
  expect(lapsedDividend("2026-09-30", { exDates: monthly }, at("2026-11-10"))).toEqual({ lastPaid: "2026-09-30", historyEnds: true });
  expect(noCurrentDividend({ lastPaid: "2026-09-30", historyEnds: true })).toBe("distribution history ends 2026-09-30");
  // Annual, and without a history to read it from: fifteen months, as Gloom Cloud withdraws a yield.
  expect(lapsedDividend("2025-05-10", { exDates: ["2024-05-12", "2025-05-10"] }, at("2026-08-08"))).toBeNull();
  expect(lapsedDividend("2025-05-10", { exDates: ["2024-05-12", "2025-05-10"] }, at("2026-08-09"))).toEqual({ lastPaid: "2025-05-10" });
  expect(lapsedDividend("2026-02-27", null, at("2026-10-16"))).toBeNull();
  expect(lapsedDividend("2025-05-10", null, at("2026-08-09"))).toEqual({ lastPaid: "2025-05-10" });
  // The latest date known counts, the rate's own or the history's; one declared and still owed keeps it current.
  expect(lapsedDividend("2026-02-27", { exDates: [...quarterly, "2026-06-01"] }, at("2026-07-14"))).toBeNull();
  expect(lapsedDividend("2026-11-19", { exDates: quarterly }, at("2026-10-16"))).toBeNull();
  expect(lapsedDividend("2026-02-27", { exDates: quarterly, declared: [{ exDate: "2026-11-02" }] }, at("2026-10-16"))).toBeNull();
});

test("a monthly payer's history ends once its latest distribution is more than 40 days old", () => {
  const at = (day: string) => new Date(`${day}T15:00:00Z`);
  // MUB on 2026-11-06: the history stops at 2026-09-01 while the fund paid on 1 October and 2 November.
  const mub = ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-03", "2026-09-01"];
  expect(monthlyHistoryEnd({ exDates: mub }, at("2026-11-06"))).toBe("2026-09-01");
  expect(monthlyHistoryEnd({ exDates: mub }, at("2026-10-11"))).toBeNull();
  // A quarterly payer is due later, and a declared distribution says the next one is known.
  expect(monthlyHistoryEnd({ exDates: ["2025-12-15", "2026-03-16", "2026-06-15", "2026-09-15"] }, at("2026-11-06"))).toBeNull();
  expect(monthlyHistoryEnd({ exDates: mub, declared: [{ exDate: "2026-12-01" }] }, at("2026-11-06"))).toBeNull();
  expect(monthlyHistoryEnd({ exDates: null }, at("2026-11-06"))).toBeNull();
});

test("a monthly payer silent more than 183 days stopped paying, and says so wherever its yield shows", () => {
  const at = (day: string) => new Date(`${day}T15:00:00Z`);
  // FXF paid monthly until 2024-04-01: 183 days on, its history still ends there; from day 184 it has no current dividend.
  const fxf = ["2024-01-02", "2024-02-01", "2024-03-01", "2024-04-01"];
  expect(lapsedDividend("2024-04-01", { exDates: fxf }, at("2024-10-01"))).toEqual({ lastPaid: "2024-04-01", historyEnds: true });
  expect(lapsedDividend("2024-04-01", { exDates: fxf }, at("2024-10-02"))).toEqual({ lastPaid: "2024-04-01" });
  expect(monthlyHistoryEnd({ exDates: fxf }, at("2026-11-06"))).toBeNull();
  const lapse = lapsedDividend("2024-04-01", { exDates: fxf }, at("2026-11-06"))!;
  expect(noCurrentDividend(lapse)).toBe("no current dividend (last paid 2024-04-01)");
  expect([lapseValue(lapse), lastPaidNote(lapse)]).toEqual(["no current dividend", "last paid 2024-04-01"]);
  // A history that ends reads the same in a short cell: `history ends`, beside its last ex-date.
  const ended = lapsedDividend("2024-04-01", { exDates: fxf }, at("2024-06-01"))!;
  expect([lapseValue(ended), lastPaidNote(ended)]).toEqual(["history ends", "last ex 2024-04-01"]);
});
