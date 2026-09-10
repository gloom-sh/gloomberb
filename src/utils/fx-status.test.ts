import { expect, test } from "bun:test";
import { summarizeFxRates, fxStatusLabel } from "./fx-status";
import { createIdleEntry } from "../market-data/result-types";

test("cross-currency status exposes oldest source time, stale fallback, missing and undated rates separately", () => {
  const now = Date.parse("2026-09-10T21:00:00Z");
  const eur = { ...createIdleEntry<number>(), phase: "ready" as const, data: 1.16, source: "yahoo", asOf: now - 45 * 60_000, fetchedAt: now - 30 * 60_000, staleAt: now + 30 * 60_000 };
  const jpy = { ...eur, data: 1 / 154, asOf: now - 2 * 60 * 60_000, fetchedAt: now - 2 * 60 * 60_000, staleAt: now - 60 * 60_000, error: { reasonCode: "offline", message: "offline" } };
  const read = (currency: string) => currency === "EUR" ? eur : currency === "JPY" ? jpy : null;
  const rates = new Map([["USD", 1], ["EUR", 1.16], ["JPY", 1 / 154], ["GBP", 1.33]]);
  const status = summarizeFxRates(["USD", "EUR", "JPY", "GBP", "CHF", "EUR"], rates, read, now);
  expect(status).toMatchObject({ unavailable: 1, stale: 1, unknownTime: 1, oldestAsOf: jpy.asOf, latestFetchedAt: eur.fetchedAt, sources: ["yahoo"] });
  expect(fxStatusLabel(status)).toContain("oldest rate 2026-09-10 19:00 UTC");
  expect(fxStatusLabel(status)).toContain("1 rate time unknown");
  expect(summarizeFxRates(["USD"], rates, read, now).oldestAsOf).toBeNull();
});
