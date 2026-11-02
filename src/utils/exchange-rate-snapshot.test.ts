import { expect, test } from "bun:test";
import { exchangeRateMetadata, MAX_FX_OBSERVATION_AGE_MS } from "./exchange-rate-snapshot";

test("FX retention is bounded by observation age, independent of a recent fetch", () => {
  const now = Date.parse("2026-09-10T22:00:00Z");
  const sourceTime = now - 6 * 86_400_000;
  const recent = { rate: 1.16, fromCurrency: "EUR", toCurrency: "USD", fetchedAt: new Date(now).toISOString() };
  expect(exchangeRateMetadata({ ...recent, asOf: new Date(sourceTime).toISOString() }, "EUR", now))
    .toMatchObject({ fetchedAt: now, asOf: sourceTime, expiresAt: sourceTime + MAX_FX_OBSERVATION_AGE_MS, staleAt: Date.parse("2026-09-06T22:00:00Z") });
  for (const data of [
    { ...recent, asOf: new Date(now - MAX_FX_OBSERVATION_AGE_MS).toISOString() },
    { ...recent, asOf: new Date(now + 120_000).toISOString() },
    { ...recent, asOf: "invalid" },
    { ...recent, fetchedAt: "invalid" },
    { ...recent, staleAt: "invalid" },
    { ...recent, fromCurrency: "JPY" },
  ]) expect(() => exchangeRateMetadata(data, "EUR", now)).toThrow();
  expect(() => exchangeRateMetadata({ rate: 1.16 }, "EUR", now, now - MAX_FX_OBSERVATION_AGE_MS)).toThrow();
  expect(exchangeRateMetadata({ ...recent, stale: true, asOf: new Date(now).toISOString() }, "EUR", now).staleAt).toBe(now);
  expect(exchangeRateMetadata(1, "USD", now, 0)).toEqual({ staleAt: Infinity, expiresAt: Infinity, source: "identity" });
  expect(() => exchangeRateMetadata(1.01, "USD", now, 0)).toThrow();
});

test("Friday's closing FX rate stays current over the weekend, even from a snapshot fetched hours ago", () => {
  const now = Date.parse("2026-09-26T15:00:00Z");
  const snapshot = { rate: 1.16, fromCurrency: "EUR", toCurrency: "USD", asOf: "2026-09-25T20:59:00Z",
    fetchedAt: "2026-09-26T12:00:00Z", staleAt: "2026-09-27T22:14:00Z", delayMinutes: 15 };
  // The retrieval ages from Sunday's open too, an hour of trading later.
  expect(exchangeRateMetadata(snapshot, "EUR", now).staleAt).toBe(Date.parse("2026-09-27T22:00:00Z"));
  // A pair that stopped updating Thursday is still stale.
  expect(exchangeRateMetadata({ ...snapshot, asOf: "2026-09-24T12:00:00Z", staleAt: undefined }, "EUR", now).staleAt)
    .toBe(Date.parse("2026-09-24T13:15:00Z"));
});

test("a rate read before the FX week closed is read again once the close is out, whether it is asked on Friday or Sunday", () => {
  // A 15-minute delayed 20:39Z print read at 20:54Z on Friday 30 Oct 2026, the week closing at 21:00Z.
  const preClose = { rate: 1.1168193, fromCurrency: "EUR", toCurrency: "USD", asOf: "2026-10-30T20:39:00Z", delayMinutes: 15 };
  const readAt = Date.parse("2026-10-30T20:54:00Z");
  const closeOut = Date.parse("2026-10-30T21:15:00Z");
  for (const now of [readAt, Date.parse("2026-11-01T16:30:00Z")]) {
    expect(exchangeRateMetadata(preClose, "EUR", now, readAt).staleAt).toBe(closeOut);
  }
  // The close itself, the week's last minute, stands until the market reopens (Sunday 22:00Z, New York back on winter time).
  const close = { ...preClose, rate: 1.11601, asOf: "2026-10-30T20:59:00Z" };
  expect(exchangeRateMetadata(close, "EUR", closeOut, closeOut).staleAt).toBeGreaterThan(Date.parse("2026-11-01T22:00:00Z"));
  // A bare rate states no delay, so it may still be the 20:50Z print: read at 21:05Z, it is read again at 21:15Z, then stands.
  const bareAt = Date.parse("2026-10-30T21:05:00Z");
  expect(exchangeRateMetadata(1.1165, "EUR", bareAt, bareAt).staleAt).toBe(closeOut);
  expect(exchangeRateMetadata(1.11601, "EUR", closeOut, closeOut).staleAt).toBeGreaterThan(Date.parse("2026-11-01T22:00:00Z"));
  // Midweek the rule waits for Friday: an hour of trading ages the rate first.
  const midweek = Date.parse("2026-10-28T12:00:00Z");
  expect(exchangeRateMetadata({ ...preClose, asOf: "2026-10-28T11:45:00Z" }, "EUR", midweek, midweek).staleAt).toBe(Date.parse("2026-10-28T13:00:00Z"));
});
