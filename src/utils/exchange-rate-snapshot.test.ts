import { expect, test } from "bun:test";
import { exchangeRateMetadata, MAX_FX_OBSERVATION_AGE_MS } from "./exchange-rate-snapshot";

test("FX retention is bounded by observation age, independent of a recent fetch", () => {
  const now = Date.parse("2026-09-10T22:00:00Z");
  const sourceTime = now - 6 * 86_400_000;
  const recent = { rate: 1.16, fromCurrency: "EUR", toCurrency: "USD", fetchedAt: new Date(now).toISOString() };
  expect(exchangeRateMetadata({ ...recent, asOf: new Date(sourceTime).toISOString() }, "EUR", now))
    .toMatchObject({ fetchedAt: now, asOf: sourceTime, expiresAt: sourceTime + MAX_FX_OBSERVATION_AGE_MS, staleAt: sourceTime + 3_600_000 });
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
});
