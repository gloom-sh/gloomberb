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
