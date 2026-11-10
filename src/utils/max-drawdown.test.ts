import { expect, test } from "bun:test";
import { closeMoves, maxDrawdown, maxDrawdownText, maxRunUp, maxRunUpText } from "./max-drawdown";

const bar = (date: string, close: number | null) => ({ date, close });

test("the largest fall is from the highest close before it to the lowest after, not the series' high and low", () => {
  // The series' high (60, in 2010) comes after its low (16, in 2009): that is no fall.
  const series = [bar("2007-05-09", 53.2), bar("2007-10-01", 48), bar("2008-09-15", 30), bar("2009-03-09", 15.9), bar("2009-12-31", 41.67),
    bar("2010-01-04", 42), bar("2008-01-02", 50)];
  const drawdown = maxDrawdown(series)!;
  expect(drawdown.peak).toEqual({ date: "2007-05-09", close: 53.2 });
  expect(drawdown.trough).toEqual({ date: "2009-03-09", close: 15.9 });
  expect(drawdown.drawdown).toBeCloseTo(15.9 / 53.2 - 1, 12);
  expect([drawdown.recovered, drawdown.through]).toEqual([null, "2010-01-04"]);
  expect(maxDrawdownText(drawdown, { basis: "daily closes", price: (value) => value.toFixed(2) }))
    .toBe("Max drawdown -70.1% (daily closes): peak 53.20 on 2007-05-09, trough 15.90 on 2009-03-09, not back to the peak by 2010-01-04");
});

test("a later, smaller fall does not replace the larger one, the recovery is the first close back at the peak, and gaps are skipped", () => {
  const series = [bar("2020-01-01", 100), bar("2020-02-01", 70), bar("2020-03-01", null), bar("2020-04-01", 0), bar("2020-05-01", 100),
    bar("2020-06-01", 120), bar("2020-07-01", 100)];
  const drawdown = maxDrawdown(series)!;
  expect([drawdown.peak.date, drawdown.trough.date, drawdown.recovered]).toEqual(["2020-01-01", "2020-02-01", "2020-05-01"]);
  expect(drawdown.drawdown).toBeCloseTo(-0.3, 12);
  expect(maxDrawdown([bar("2020-01-01", 1), bar("2020-01-02", 2)])!.drawdown).toBe(0);
  expect(maxDrawdownText(maxDrawdown([bar("2020-01-01", 1), bar("2020-01-02", 2)])!, { basis: "daily closes", price: String }))
    .toBe("Max drawdown 0.0% (daily closes): no close fell below an earlier one");
  expect(maxDrawdown([bar("2020-01-01", 1), bar("2020-01-02", null)])).toBeNull();
  // A fall that rounds to nothing is not printed as -0.0%.
  expect(maxDrawdownText(maxDrawdown([bar("2020-01-01", 100), bar("2020-01-02", 99.96)])!, { basis: "daily closes", price: String }))
    .toBe("Max drawdown under 0.1% (daily closes): peak 100 on 2020-01-01, trough 99.96 on 2020-01-02, not back to the peak by 2020-01-02");
});

test("a yield falls and rises by its level, in bp: the deepest fall in points, not the largest ratio", () => {
  // ^TNX from 20 Oct to 5 Dec 2025: 4.157 to 3.998 is -15.9bp.
  const tnx = [bar("2025-10-20", 3.986), bar("2025-10-22", 3.953), bar("2025-11-05", 4.157), bar("2025-11-26", 3.998), bar("2025-12-05", 4.139)];
  const text = { basis: "daily closes", price: (value: number) => value.toFixed(3) };
  const drawdown = maxDrawdown(tnx, "yield")!;
  expect([drawdown.peak.close, drawdown.trough.close, drawdown.bp]).toEqual([4.157, 3.998, -15.9]);
  expect(maxDrawdownText(drawdown, text))
    .toBe("Max drawdown -16bp (daily closes): peak 4.157 on 2025-11-05, trough 3.998 on 2025-11-26, not back to the peak by 2025-12-05");
  expect(maxRunUpText(maxRunUp(tnx)!, text))
    .toBe("Max run-up +20bp (daily closes): low 3.953 on 2025-10-22, high 4.157 on 2025-11-05, not back to the low by 2025-12-05");
  // By level a fall from 1.00 to 0.50 (50bp) is smaller than one from 5.00 to 4.00 (100bp), though its ratio is larger; a yield at zero is a close.
  const levels = [bar("2020-01-01", 5), bar("2020-02-01", 4), bar("2020-03-01", 1), bar("2020-04-01", 0.5), bar("2020-05-01", 0)];
  expect(maxDrawdown(levels, "yield")!.bp).toBe(-500);
  expect(closeMoves(levels.slice(2), "yield", text).lines).toEqual([
    "Max drawdown -100bp (daily closes): peak 1.000 on 2020-03-01, trough 0.000 on 2020-05-01, not back to the peak by 2020-05-01",
    "Max run-up 0bp (daily closes): no close rose above an earlier one",
  ]);
});

test("\"not back to the peak by\" is never later than the end asked for, nor earlier than a date the move names", () => {
  // `history ^NDX --from 1998 --to 2003`: the last weekly close is dated by its week's Friday, 2 Jan 2004.
  const series = [bar("2000-03-10", 4704.73), bar("2002-10-04", 804.64), bar("2004-01-02", 1467.92)];
  const text = { basis: "weekly closes", price: (value: number) => value.toFixed(2) };
  expect(closeMoves(series, "price", text).lines[0]).toEndWith("not back to the peak by 2004-01-02");
  expect(closeMoves(series, "price", text, "2003-12-31").lines[0]).toEndWith("not back to the peak by 2003-12-31");
  // An end before the trough is no end the move can be measured to.
  expect(closeMoves(series, "price", text, "2001-01-01").drawdown!.through).toBe("2002-10-04");
});
