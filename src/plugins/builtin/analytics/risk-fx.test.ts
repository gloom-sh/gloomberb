import { expect, test } from "bun:test";
import { resolveDatedReturns } from "./metrics";
import { convertClosesToUsd, FX_GAP, FX_STALE, LOCAL_GAP, riskConversion, validateFxHistory, type FxCloses } from "./risk-fx";

const fx = (rates: Record<string, number>): FxCloses => {
  const dates = Object.keys(rates).sort();
  return { currency: "JPY", closes: new Map(Object.entries(rates)), first: dates[0]!, asOf: dates.at(-1)! };
};
const usd = (points: ReturnType<typeof convertClosesToUsd>) =>
  points.map((point) => [point.date.toISOString().slice(0, 10), point.close] as const);

// 2026-09-07 is Labor Day (NYSE closed, the local market open); 2026-09-09 is a local holiday.
const local = [
  { date: "2026-09-03", close: 1000 },
  { date: "2026-09-04", close: 1010 },
  { date: "2026-09-07", close: 1020 },
  { date: "2026-09-08", close: 1030 },
  { date: "2026-09-10", close: 1040 },
];
const rates = {
  "2026-09-03": 0.0068, "2026-09-04": 0.0069, "2026-09-07": 0.007,
  "2026-09-08": 0.0071, "2026-09-09": 0.0072, "2026-09-10": 0.0073,
};

test("local closes restate in USD on each NYSE session at that date's FX close", () => {
  const converted = convertClosesToUsd(local, fx(rates), 1);
  expect(usd(converted).map(([date]) => date)).toEqual(["2026-09-03", "2026-09-04", "2026-09-08", "2026-09-09", "2026-09-10"]);
  const value = new Map(usd(converted));
  // A local holiday on a US session: the last local close, moved by that day's rate alone.
  expect(value.get("2026-09-09")).toBeCloseTo(1030 * 0.0072, 12);
  const returns = resolveDatedReturns(converted).returns;
  // The return over the US holiday compounds both local sessions and the FX move over the same span.
  const span = returns.find((row) => row.startDateKey === "2026-09-04")!;
  expect(span.dateKey).toBe("2026-09-08");
  expect(span.value).toBeCloseTo((1030 / 1010) * (0.0071 / 0.0069) - 1, 12);
  // Pence restate through the pound.
  expect(convertClosesToUsd(local, fx(rates), 100)[0]!.close).toBeCloseTo(1000 * 0.0068 / 100, 12);
});

test("missing FX closes, long local silences and lagging data never bridge a gap", () => {
  const { "2026-09-08": _missing, ...gapped } = rates;
  expect(() => convertClosesToUsd(local, fx(gapped), 1)).toThrow(FX_GAP);
  // The local market's own closures need no FX close: Labor Day missing changes nothing.
  const { "2026-09-07": _holiday, ...withoutHoliday } = rates;
  expect(convertClosesToUsd(local, fx(withoutHoliday), 1)).toHaveLength(5);
  const silent = [{ date: "2026-08-20", close: 990 }, ...local.slice(1)];
  const augustRates = Object.fromEntries(
    Array.from({ length: 22 }, (_, day) => [`2026-08-${String(day + 10).padStart(2, "0")}`, 0.0068]),
  );
  expect(() => convertClosesToUsd(silent, fx({ ...augustRates, ...rates }), 1)).toThrow(LOCAL_GAP);
  // FX that ends earlier ends the series there instead of carrying a rate forward.
  const { "2026-09-10": _lagging, ...early } = rates;
  expect(usd(convertClosesToUsd(local, fx(early), 1)).at(-1)?.[0]).toBe("2026-09-09");
});

test("a pair quoted per dollar inverts to USD per unit and drops today's bar", () => {
  const conversion = riskConversion("JPY")!;
  expect(conversion.leg.instrument.symbol).toBe("JPY=X");
  const row = (date: string, close: number) => ({ date: `${date}T00:00:00.000Z`, open: close, high: close, low: close, close });
  const closes = validateFxHistory(
    { status: "success", data: [row("2026-09-21", 150), row("2026-09-22", 160), row("2026-09-18", 148)] },
    conversion.leg,
    new Date("2026-09-22T12:00:00Z"),
  );
  expect(closes.asOf).toBe("2026-09-21");
  expect(closes.closes.get("2026-09-21")).toBeCloseTo(1 / 150, 15);
  expect(riskConversion("GBp")).toMatchObject({ currency: "GBP", divisor: 100 });
  expect(() =>
    validateFxHistory({ status: "success", data: [row("2026-09-01", 150), row("2026-09-02", 151)] }, conversion.leg, new Date("2026-09-22T12:00:00Z")),
  ).toThrow(FX_STALE);
});
