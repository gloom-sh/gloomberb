import { expect, test } from "bun:test";
import { resolveDatedReturns } from "./metrics";
import {
  convertClosesToUsd,
  convertReturnsToAccount,
  FX_GAP,
  FX_STALE,
  fxBridgeNote,
  LOCAL_GAP,
  riskConversion,
  validateFxHistory,
  type FxCloses,
} from "./risk-fx";

const fx = (rates: Record<string, number>): FxCloses => {
  const dates = Object.keys(rates).sort();
  return { currency: "JPY", closes: new Map(Object.entries(rates)), first: dates[0]!, asOf: dates.at(-1)! };
};
const usd = ({ points }: ReturnType<typeof convertClosesToUsd>) =>
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
  expect(converted.bridged).toEqual([]);
  const returns = resolveDatedReturns(converted.points).returns;
  // The return over the US holiday compounds both local sessions and the FX move over the same span.
  const span = returns.find((row) => row.startDateKey === "2026-09-04")!;
  expect(span.dateKey).toBe("2026-09-08");
  expect(span.value).toBeCloseTo((1030 / 1010) * (0.0071 / 0.0069) - 1, 12);
  // Pence restate through the pound.
  expect(convertClosesToUsd(local, fx(rates), 100).points[0]!.close).toBeCloseTo(1000 * 0.0068 / 100, 12);
});

test("a US session without an FX close converts at the close before it, up to three FX trading days back", () => {
  // 8 Sep has no close: it converts at 7 Sep's, and says so.
  const { "2026-09-08": _missing, ...gapped } = rates;
  const bridged = convertClosesToUsd(local, fx(gapped), 1);
  expect(bridged.bridged).toEqual(["2026-09-08"]);
  expect(new Map(usd(bridged)).get("2026-09-08")).toBeCloseTo(1030 * 0.007, 12);
  // Four FX trading days without a close are missing data: 3, 4, 7 and 8 Sep, before 9 Sep.
  const longGap = { "2026-09-02": 0.0067, "2026-09-09": 0.0072, "2026-09-10": 0.0073 };
  expect(() => convertClosesToUsd([{ date: "2026-09-02", close: 990 }, ...local], fx(longGap), 1)).toThrow(FX_GAP);
});

test("long local silences and lagging data never bridge a gap", () => {
  // The local market's own closures need no FX close: Labor Day missing changes nothing.
  const { "2026-09-07": _holiday, ...withoutHoliday } = rates;
  expect(convertClosesToUsd(local, fx(withoutHoliday), 1).points).toHaveLength(5);
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

test("account returns cross Good Friday and Easter Monday at Thursday's close, and say so", () => {
  // GBP/USD's daily closes, USD per pound, without 18 or 21 Apr 2025.
  const closes = { "2025-04-16": 1.32, "2025-04-17": 1.325, "2025-04-22": 1.33, "2025-04-23": 1.335 };
  const account = { currency: "GBP", closes, first: "2025-04-16", asOf: "2025-04-23" };
  const returns = [
    { startDateKey: "2025-04-16", dateKey: "2025-04-17", value: 0.01 },
    // NYSE closed on Good Friday, open on Easter Monday.
    { startDateKey: "2025-04-17", dateKey: "2025-04-21", value: 0.02 },
    { startDateKey: "2025-04-21", dateKey: "2025-04-22", value: -0.01 },
  ];
  const converted = convertReturnsToAccount(returns, account);
  expect(converted.bridged).toEqual(["2025-04-21"]);
  // Easter Monday is worth Thursday's close: its return moves with the holding alone.
  expect(converted.returns[1]!.value).toBeCloseTo(0.02, 12);
  expect(converted.returns[2]!.value).toBeCloseTo(0.99 * (1.325 / 1.33) - 1, 12);
  expect(fxBridgeNote("GBP/USD", converted.bridged))
    .toBe("GBP/USD has no daily close on 2025-04-21; the returns across it use the close before it.");
  expect(fxBridgeNote("GBP/USD", ["2025-04-21", "2025-04-18", "2025-04-21"]))
    .toBe("GBP/USD has no daily close on 2025-04-18 and 2025-04-21; the returns across them use the close before each.");
  expect(fxBridgeNote("GBP/USD", [])).toBeNull();
  // Four FX trading days without a close are missing data, never bridged.
  const gapped = { "2025-04-14": 1.31, "2025-04-21": 1.33, "2025-04-22": 1.335 };
  expect(() => convertReturnsToAccount([{ startDateKey: "2025-04-14", dateKey: "2025-04-18", value: 0 }],
    { currency: "GBP", closes: gapped, first: "2025-04-14", asOf: "2025-04-22" })).toThrow("GBP/USD daily FX history has gaps longer than three days");
});
