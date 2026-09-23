import { expect, test } from "bun:test";
import { createIdleEntry } from "../../../market-data/result-types";
import { createDataTableCsv } from "../../../components/data-table/export";
import { createFxExportMetadata } from "./export";

test("cross exports keep each leg's observation, receipt, raw rate and stale failure", () => {
  const now = Date.UTC(2026, 8, 11, 15);
  const read = (currency: string) => ({ ...createIdleEntry<number>(), phase: "ready" as const,
    data: currency === "EUR" ? 1.2 : 1.5, source: currency, asOf: now - (currency === "EUR" ? 10 : 180) * 60_000,
    fetchedAt: now - 1000, staleAt: currency === "EUR" ? now + 60_000 : now - 60_000,
    error: currency === "GBP" ? { reasonCode: "TIMEOUT", message: "=provider,failed" } : null });
  const metadata = createFxExportMetadata(["USD", "EUR", "GBP"], new Map([["USD", 1], ["EUR", 1.2], ["GBP", 1.5]]), read, now);
  expect(metadata[2]).toEqual(["USD", 1, "", "", "identity", ""]);
  expect(metadata[3]).toEqual(["EUR", 1.2, new Date(now - 600_000).toISOString(), new Date(now - 1000).toISOString(), "current", ""]);
  expect(metadata[4]).toEqual(["GBP", 1.5, new Date(now - 10_800_000).toISOString(), new Date(now - 1000).toISOString(), "stale", "=provider,failed"]);
  const csv = createDataTableCsv({ columns: [{ id: "rate", label: "EUR/GBP", width: 10 }], items: ["0.8000"],
    renderCell: (text) => ({ text }), getExportMetadata: () => metadata });
  expect(csv).toStartWith("\uFEFFEUR/GBP\n0.8000\n\nCross rate,");
  expect(csv).toContain('"\'=provider,failed"');
});

test("missing and unknown times remain explicit, including invalid Date bounds", () => {
  const rows = createFxExportMetadata(["EUR", "GBP", "JPY"], new Map([["GBP", 1.5], ["JPY", 1 / 150]]),
    (currency) => currency === "EUR" ? { ...createIdleEntry<number>(), phase: "loading" } : {
      ...createIdleEntry<number>(), asOf: currency === "GBP" ? 9e15 : NaN, fetchedAt: Infinity,
    });
  expect(rows[2]).toEqual(["EUR", "", "", "", "unavailable; loading", ""]);
  expect(rows[3]).toEqual(["GBP", 1.5, "", "", "time unknown", ""]);
  expect(rows[4]).toEqual(["JPY", 1 / 150, "", "", "time unknown", ""]);
});
