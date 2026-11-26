import { expect, test } from "bun:test";
import { adjustedForText, adjustmentsAfter, priceAdjustment, priceAdjustments } from "./price-adjustments";

const vylor = {
  exDate: "2026-10-01", recordDate: "2026-09-24", business: "seed", ratio: 1,
  successor: { symbol: "VYLR", exchange: "NYSE", name: "Vylor Inc.", listedOn: "2026-10-01" },
};

test("a factor is a spin-off only where a demerger on record shares its date; another in no share terms is a neutral factor", () => {
  // Confirmed: CTVA's 6665:1000 on the day its seed business left as VYLR.
  expect(priceAdjustment({ date: "2026-10-01", fromFactor: 1000, toFactor: 6665 }, [vylor]))
    .toEqual({ date: "2026-10-01", factor: 6.665, terms: "6665:1000", demerger: vylor });
  // Unclassified: the same factor with nothing on record, or a demerger of another day.
  for (const demergers of [[], [{ ...vylor, exDate: "2026-09-30" }]]) {
    expect(priceAdjustment({ date: "2026-10-01", fromFactor: 1000, toFactor: 6665 }, demergers))
      .toEqual({ date: "2026-10-01", factor: 6.665, terms: "6665:1000" });
  }
  // Real splits stay splits, a demerger's day or not: share terms, and a reverse one that raises the price.
  expect(priceAdjustment({ date: "2025-11-17", fromFactor: 1, toFactor: 10 })).toBeNull();
  expect(priceAdjustment({ date: "2024-04-22", fromFactor: 10, toFactor: 11 })).toBeNull();
  expect(priceAdjustment({ date: "2026-10-01", fromFactor: 150, toFactor: 1 }, [vylor])).toBeNull();
  expect(priceAdjustment({ date: "2026-10-01" }, [vylor])).toBeNull();
});

test("figures before an adjustment are labelled with what adjusted them, never multiplied back", () => {
  // GE: its 1-for-8 reverse split is a split; 1281:1000 and 1253:1000 have no demerger on record.
  const adjustments = priceAdjustments([
    { date: "2024-04-02", fromFactor: 1000, toFactor: 1253 },
    { date: "2021-08-02", fromFactor: 8, toFactor: 1 },
    { date: "2023-01-04", fromFactor: 1000, toFactor: 1281 },
  ], []);
  expect(adjustments.map((adjustment) => adjustment.date)).toEqual(["2023-01-04", "2024-04-02"]);
  expect(adjustedForText(adjustmentsAfter(adjustments, "2022-12-14")))
    .toBe("adjusted by the 1281:1000 factor of 2023-01-04 and by the 1253:1000 factor of 2024-04-02");
  expect(adjustedForText(adjustmentsAfter(adjustments, "2024-04-12"))).toBe("");
  const ctva = priceAdjustments([{ date: "2026-10-01", fromFactor: 1000, toFactor: 6665 }], [vylor]);
  expect(adjustedForText(adjustmentsAfter(ctva, "2026-09-01"))).toBe("adjusted for the VYLR spin-off of 2026-10-01 (6665:1000)");
  expect(adjustedForText(adjustmentsAfter(ctva, "2026-09-01"), false)).toBe("adjusted for the VYLR spin-off");
});
