import { expect, test } from "bun:test";
import { maxDrawdown, maxDrawdownText } from "./max-drawdown";

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
