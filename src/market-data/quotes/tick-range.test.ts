import { expect, test } from "bun:test";
import type { Quote } from "../../types/financials";
import { foldStreamTick, mergeStreamTickRanges, readStreamTickRange, streamTicksAsShown, type StreamTickRange } from "./tick-range";

const CLOSE = 100;

/** A tick that names its session, or an after-hours one that names none: the regular close and its print. */
type Tick = { named: number } | { afterHours: number };
const quoteOf = (tick: Tick): Quote => ("named" in tick
  ? { price: tick.named, marketState: "REGULAR" }
  : { price: CLOSE, postMarketPrice: tick.afterHours, previousClose: CLOSE }) as Quote;

function expected(prices: number[]) {
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return {
    low, high, last: prices.at(-1),
    roseFromLow: prices.slice(prices.indexOf(low) + 1).some((price) => price > low),
    fellFromHigh: prices.slice(prices.indexOf(high) + 1).some((price) => price < high),
  };
}

const shape = (range: StreamTickRange | undefined) => range && {
  low: range.low.price, high: range.high.price, last: range.last, roseFromLow: range.roseFromLow, fellFromHigh: range.fellFromHigh,
};

test("ticks that name no session are kept as an after-hours quote shows them, across frames, beside the range as they read alone", () => {
  // A fixed sequence of draws, so every run checks the same cases.
  let seed = 11;
  const draw = (count: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.floor((seed / 2_147_483_648) * count);
  };
  const prices = [98, 99, 100, 101, 102];
  const fold = (ticks: Tick[]) => ticks.reduce<StreamTickRange | null>((range, tick) => foldStreamTick(range, quoteOf(tick)), null);
  for (let run = 0; run < 3_000; run += 1) {
    const ticks: Tick[] = Array.from({ length: 1 + draw(6) }, () => draw(2) === 0
      ? { named: prices[draw(prices.length)]! } : { afterHours: prices[draw(prices.length)]! + 10 });
    const cut = draw(ticks.length);
    const first = fold(ticks.slice(0, cut));
    const range = mergeStreamTickRanges(first ?? undefined, fold(ticks.slice(cut))!);
    const asTheyRead = ticks.map((tick) => "named" in tick ? tick.named : CLOSE);
    const afterHours = ticks.map((tick) => "named" in tick ? tick.named : tick.afterHours);
    const anyAfterHours = ticks.some((tick) => "afterHours" in tick);
    expect({ ticks, cut, main: shape(range), post: shape(range.sessions?.POST) })
      .toEqual({ ticks, cut, main: expected(asTheyRead), post: anyAfterHours ? expected(afterHours) : undefined });
    // A quote in the session reads them at their print; one in the regular session as they read alone.
    const last = ticks.at(-1)!;
    if (anyAfterHours && "afterHours" in last) {
      const post = { price: CLOSE, marketState: "POST", postMarketPrice: last.afterHours, previousClose: CLOSE } as Quote;
      const shown = streamTicksAsShown(range, post);
      expect(shape(shown ?? undefined)).toEqual(new Set(afterHours).size > 1 ? expected(afterHours) : undefined);
      expect(shown?.sessions).toBeUndefined();
    }
  }
});

test("regular-only extrema survive mixed-session frames without taking extended prints", () => {
  const pre = foldStreamTick(null, { price: 99, marketState: "PRE", preMarketPrice: 145 } as Quote)!;
  const regular = foldStreamTick(pre, quoteOf({ named: 137.59 }))!;
  const closing = foldStreamTick(foldStreamTick(null, quoteOf({ named: 138 })), { price: 140, marketState: "POST", postMarketPrice: 141.7 } as Quote)!;
  const merged = mergeStreamTickRanges(regular, closing);
  expect(shape(merged.regular)).toEqual(expected([137.59, 138]));
  expect(shape(readStreamTickRange(JSON.parse(JSON.stringify(merged)))?.regular)).toEqual(expected([137.59, 138]));
});

test("a range read back from JSON keeps its sessions and drops what is not one", () => {
  const range = [{ afterHours: 105 }, { afterHours: 103 }, { named: 100 }].reduce<StreamTickRange | null>(
    (folded, tick) => foldStreamTick(folded, quoteOf(tick as Tick)), null)!;
  const wire = JSON.parse(JSON.stringify({ ...range, low: { ...range.low, change: Number.NaN } }));
  expect(readStreamTickRange(wire)).toEqual({ ...range, low: { ...range.low, change: undefined } });
  for (const broken of [null, "range", { ...wire, last: null }, { ...wire, low: { price: 101 } }, { ...wire, roseFromLow: "yes" }]) {
    expect(readStreamTickRange(broken)).toBeUndefined();
  }
});
