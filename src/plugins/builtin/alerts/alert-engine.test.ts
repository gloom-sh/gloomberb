import { describe, expect, test } from "bun:test";
import { foldStreamTick, mergeStreamTickRanges, type StreamTickRange } from "../../../market-data/quotes/tick-range";
import type { Quote } from "../../../types/financials";
import { evaluateAlert, createAlert, editAlert, rearmAlert, serializeAlerts, deserializeAlerts, readAlertsStoreError, tickTrigger } from "./alert-engine";
import { useAlertTestClock } from "./test-fixture";

useAlertTestClock();

test("a level alert goes off past its level, never at it, and a crossing needs the price before", () => {
  const above = createAlert("AAPL", "above", 200);
  expect([199, 200, 201].map((price) => evaluateAlert(above, price))).toEqual([false, false, true]);
  const below = createAlert("AAPL", "below", 150);
  expect([151, 150, 149].map((price) => evaluateAlert(below, price))).toEqual([false, false, true]);
  const crosses = createAlert("AAPL", "crosses", 180);
  expect(evaluateAlert(crosses, 185)).toBe(false);
  expect(evaluateAlert({ ...crosses, lastCheckedPrice: 175 }, 185)).toBe(true);
  expect(evaluateAlert({ ...crosses, lastCheckedPrice: 185 }, 175)).toBe(true);
  expect(evaluateAlert({ ...above, status: "triggered" }, 999)).toBe(false);
});

test("the ticks a frame folds in set off a price alert exactly when one of them, judged in turn, would", () => {
  // A fixed sequence of draws, so every run checks the same cases.
  let seed = 7;
  const draw = (count: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.floor((seed / 2_147_483_648) * count);
  };
  // Prices on and either side of the level, where touching it counts as either side.
  const prices = [98, 99, 100, 101, 102];
  const range = (part: number[]) => part.reduce<StreamTickRange | null>((ticks, price) => foldStreamTick(ticks, { price } as Quote), null);
  for (let run = 0; run < 3_000; run += 1) {
    const sequence = Array.from({ length: 1 + draw(6) }, () => prices[draw(prices.length)]!);
    const from = prices[draw(prices.length)]!;
    // Split over two frames, as a key held off screen gathers them.
    const cut = draw(sequence.length);
    const first = range(sequence.slice(0, cut));
    const ticks = mergeStreamTickRanges(first ?? undefined, range(sequence.slice(cut))!);
    for (const condition of ["above", "below", "crosses"] as const) {
      const alert = { ...createAlert("AAPL", condition, 100), lastCheckedPrice: from };
      let previous = from;
      const byTick = sequence.some((price) => {
        const fired = evaluateAlert({ ...alert, lastCheckedPrice: previous }, price);
        previous = price;
        return fired;
      });
      const tick = tickTrigger(alert, ticks);
      expect({ sequence, from, condition, fired: tick !== null }).toEqual({ sequence, from, condition, fired: byTick });
      // The price it notes is one that crossed.
      if (tick) expect(tick.price).not.toBe(100);
    }
  }
});

describe("editAlert", () => {
  test("keeps identity, re-arms, and clears trigger/quote lifecycle state", () => {
    const alert = {
      ...createAlert("aapl", "above", 200, "NASDAQ"),
      message: "watch this",
      status: "triggered" as const,
      triggeredAt: 123,
      lastCheckedPrice: 205,
      lastCheckedAt: 124,
      lastCheckError: "boom",
      lastQuoteUpdatedAt: 125,
      lastQuoteSource: "live" as const,
      lastQuoteProviderId: "gloom",
    };

    const edited = editAlert(alert, "aapl", "crosses", 180);

    expect(edited).toEqual({
      id: alert.id,
      symbol: "AAPL",
      exchange: "NASDAQ",
      condition: "crosses",
      targetPrice: 180,
      createdAt: alert.createdAt,
      armedAt: expect.any(Number),
      status: "active",
      message: "watch this",
    });
    // A stale lastCheckedPrice would make `crosses` fire off the previous symbol's baseline.
    expect(evaluateAlert(edited, 185)).toBe(false);
  });

  test("rearming a crosses alert drops the old quote baseline", () => {
    const alert = {
      ...createAlert("AAPL", "crosses", 180),
      armedAt: 1,
      status: "triggered" as const,
      triggeredAt: 123,
      lastCheckedPrice: 185,
    };

    const rearmed = rearmAlert(alert);

    expect(rearmed.status).toBe("active");
    expect(rearmed.lastCheckedPrice).toBeUndefined();
    expect(evaluateAlert(rearmed, 175)).toBe(false);
    // Same id, new arming: the cloud emails a trigger once per id and armedAt.
    expect(rearmed.id).toBe(alert.id);
    expect(rearmed.armedAt!).toBeGreaterThan(alert.armedAt);
  });

  test("drops the exchange when the symbol changes", () => {
    const alert = createAlert("AAPL", "above", 200, "NASDAQ");
    expect(editAlert(alert, "tsla", "above", 200).exchange).toBeUndefined();
  });
});

test("unreadable members and overflowing JSON numbers cannot be saved as a filtered list", () => {
  const legacy = { id: "old", symbol: "AAPL", condition: "above", targetPrice: 200, custom: { retained: true } };
  for (const raw of [
    JSON.stringify([legacy, null]),
    JSON.stringify([legacy, { id: "unfinished", symbol: "MSFT" }]),
    JSON.stringify([{ ...legacy, symbol: 42 }]),
    JSON.stringify([{ ...legacy, exchange: 42 }]),
    '[{"id":"overflow","symbol":"AAPL","condition":"above","targetPrice":1e400}]',
    JSON.stringify([legacy]).replace('true', '1e400'),
    { alerts: [legacy] },
    "null",
  ]) expect(readAlertsStoreError(raw)).not.toBeNull();
  // Older rows without newer lifecycle fields remain readable and keep unknown data.
  const raw = JSON.stringify([legacy]);
  expect(readAlertsStoreError(raw)).toBeNull();
  expect(serializeAlerts(deserializeAlerts(raw))).toBe(raw);
  for (const unset of [undefined, null, "", "[]"]) expect(readAlertsStoreError(unset)).toBeNull();
});
