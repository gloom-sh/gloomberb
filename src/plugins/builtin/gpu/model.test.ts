import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { equityFiveDayReturn, gpuEquityRows, gpuHistorySeries, gpuSource } from "./model";
import { gpuEvent, gpuRow } from "./test-fixture";

describe("GPU observation charts", () => {
  test("steps use collected timestamps and markers use matching observed list changes, never effective-date backfill", () => {
    const row = gpuRow();
    const points = [
      gpuRow({ observedAt: "2026-10-03T19:00:00.000Z", pricePerGpuHr: 6.98 }),
      gpuRow({ observedAt: "2026-10-01T19:00:00.000Z", effectiveAt: "2020-01-01T00:00:00.000Z", pricePerGpuHr: 7 }),
      gpuRow({ observedAt: "2026-10-02T19:00:00.000Z", pricePerGpuHr: 6.98 }),
      gpuRow({ skuKey: "h100-pcie-80", formFactor: "PCIe", observedAt: "2025-01-01T00:00:00.000Z", pricePerGpuHr: 2 }),
      gpuRow({ source: "aws-list", observedAt: "2026-10-02T19:00:00.000Z", pricePerGpuHr: 10 }),
    ];
    const events = [
      gpuEvent(),
      gpuEvent({ kind: "membership" }),
      gpuEvent({ basis: "spot" }),
      gpuEvent({ skuKey: "h100-pcie-80", formFactor: "PCIe" }),
      gpuEvent({ observedAt: "2026-09-30T19:00:00.000Z" }),
      gpuEvent({ observedAt: "2026-10-04T19:00:00.000Z" }),
    ];
    const [line, markers] = gpuHistorySeries(row, points, events, "#ffffff", "#00ff00");
    expect(line).toMatchObject({ style: "step", interpolation: "step-after", unit: "$/GPU-hr" });
    expect(line!.timeBasis).toBeUndefined();
    expect(line!.points.map((point) => [point.date.toISOString(), point.value])).toEqual([
      ["2026-10-01T19:00:00.000Z", 7], ["2026-10-02T19:00:00.000Z", 6.98], ["2026-10-03T19:00:00.000Z", 6.98],
    ]);
    expect(markers!.style).toBe("points");
    expect(markers!.points.map((point) => [point.date.toISOString(), point.value])).toEqual([["2026-10-02T19:00:00.000Z", 6.98]]);
    expect(points[0]!.observedAt).toBe("2026-10-03T19:00:00.000Z");
  });

  test("one or two observations cannot become an invented history, even with another SKU's points", () => {
    const row = gpuRow({ gpuModel: "A100", skuKey: "a100-40", memoryGb: 40 });
    const first = gpuRow({ ...row, observedAt: "2026-10-01T00:00:00.000Z" });
    const second = gpuRow({ ...row, observedAt: "2026-10-03T00:00:00.000Z" });
    for (const own of [[], [first], [first, second]]) {
      const other = [1, 2, 3].map((day) => gpuRow({ skuKey: "a100-80", gpuModel: "A100", memoryGb: 80, observedAt: `2026-10-0${day}T00:00:00.000Z` }));
      expect(gpuHistorySeries(row, [...own, ...other], [gpuEvent()], "#fff", "#0f0")).toEqual([]);
    }
  });

  test("published change markers use effective dates only within collected history; observed changes keep their observation date", () => {
    const row = gpuRow();
    const points = [1, 2, 3].map((day) => gpuRow({ observedAt: `2026-10-0${day}T19:00:00.000Z` }));
    const events = [
      gpuEvent({ origin: "published", effectiveAt: "2026-10-02T12:00:00.000Z", observedAt: "2026-10-04T19:00:00.000Z", newPrice: 6.5 }),
      gpuEvent({ origin: "published", effectiveAt: "2026-09-01T00:00:00.000Z", observedAt: "2026-10-02T19:00:00.000Z", newPrice: 5 }),
      gpuEvent({ origin: "published", effectiveAt: "2026-10-04T00:00:00.000Z", observedAt: "2026-10-02T19:00:00.000Z", newPrice: 4 }),
      gpuEvent({ origin: "observed", effectiveAt: "2020-01-01T00:00:00.000Z", observedAt: "2026-10-02T19:00:00.000Z", newPrice: 6.98 }),
    ];
    const [line, markers] = gpuHistorySeries(row, points, events, "#fff", "#0f0");
    expect(line!.points.map((point) => point.date.toISOString())).toEqual(points.map((point) => point.observedAt));
    expect(markers!.points.map((point) => [point.date.toISOString(), point.value])).toEqual([
      ["2026-10-02T12:00:00.000Z", 6.5], ["2026-10-02T19:00:00.000Z", 6.98],
    ]);
  });
});

describe("equity five-session returns", () => {
  const close = (date: string, value: number): PricePoint => ({ date: new Date(date), close: value });
  const daily = [
    close("2026-09-25", 100), close("2026-09-28", 102), close("2026-09-29", 104),
    close("2026-09-30", 106), close("2026-10-01", 108), close("2026-10-02", 110),
  ];

  test("sorts dates and counts unique trading dates, so a duplicate cannot shorten the five-session window", () => {
    const shuffled = [daily[4]!, daily[1]!, daily[5]!, daily[2]!, daily[0]!, daily[3]!, daily[5]!];
    const result = equityFiveDayReturn(shuffled);
    expect(result.value).toBeCloseTo(10);
    expect(result.asOf).toBe("2026-10-02");
    expect(shuffled[0]!.date.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  test("the latest timestamp wins within a date regardless of response order", () => {
    const duplicates = [close("2026-10-02T20:00:00.000Z", 112), ...daily, close("2026-10-02T12:00:00.000Z", 109)];
    expect(equityFiveDayReturn(duplicates).value).toBeCloseTo(12);
    expect(equityFiveDayReturn(duplicates.toReversed())).toEqual(equityFiveDayReturn(duplicates));
  });

  test("insufficient, invalid and gapped daily closes stay unavailable", () => {
    expect(equityFiveDayReturn([])).toEqual({ value: null, asOf: null });
    expect(equityFiveDayReturn(daily.slice(1))).toEqual({ value: null, asOf: "2026-10-02" });
    for (const invalid of [close("invalid", 100), close("2026-09-25", Number.NaN), close("2026-09-25", 0), close("2026-09-25", -1)]) {
      expect(equityFiveDayReturn([invalid, ...daily.slice(1)])).toEqual({ value: null, asOf: "2026-10-02" });
    }
    expect(equityFiveDayReturn([close("2026-09-01", 100), ...daily.slice(1)]))
      .toEqual({ value: null, asOf: "2026-10-02" });
  });
});

test("collection intermediaries cannot become the cloud provider displayed beside a rental price", () => {
  expect(gpuSource(gpuRow({ source: "shadeform", provider: "lambdalabs" }))).toBe("Lambda");
  expect(gpuSource(gpuRow({ source: "shadeform", provider: "nebius" }))).toBe("Nebius");
  for (const [source, provider, skuKey] of [
    ["vast", "Vast.ai", "h100-sxm"], ["akash", "Akash", "h100"],
    ["runpod", "RunPod secure", "h100-secure"], ["runpod", "RunPod community", "h100-community"],
  ]) {
    expect(gpuSource(gpuRow({ source, provider, skuKey }))).not.toMatch(/vast|akash|runpod/i);
  }
  expect(gpuSource(gpuRow({ source: "runpod", provider: "RunPod secure", skuKey: "h100-secure" })))
    .not.toBe(gpuSource(gpuRow({ source: "runpod", provider: "RunPod community", skuKey: "h100-community" })));
});

test("equities use the representative neocloud SXM series while cloud and AMD references keep their own scope", () => {
  const flagship = gpuRow({
    source: "aggregate-neocloud", provider: "Neocloud list median", providerClass: "aggregate",
    skuKey: "h100-sxm-80", stats: { n: 6, min: 2.5, max: 6 }, change7d: -3,
  });
  const pcie = gpuRow({ ...flagship, id: undefined, skuKey: "h100-pcie-80", formFactor: "PCIe", stats: { n: 1, min: 2, max: 2 }, change7d: 8 });
  const hyperscaler = gpuRow({ source: "aggregate-hyperscaler", provider: "Hyperscaler list median", providerClass: "aggregate", stats: { n: 9, min: 4, max: 10 } });
  const azure = gpuRow();
  const aws = gpuRow({ source: "aws-list", provider: "AWS", change7d: 2 });
  const amd = gpuRow({ source: "aggregate-neocloud", provider: "Neocloud list median", providerClass: "aggregate", gpuModel: "MI300X", skuKey: "mi300x-oam-192", formFactor: "OAM", memoryGb: 192 });
  const amdNew = gpuRow({ ...amd, id: undefined, gpuModel: "MI355X", skuKey: "mi355x-oam-288", memoryGb: 288 });
  const rows = [pcie, hyperscaler, azure, aws, amd, amdNew, flagship];
  const references = new Map(gpuEquityRows(rows, "H100").map((row) => [row.symbol, row.reference?.id]));
  for (const symbol of ["NVDA", "IREN", "AVGO"] as const) expect(references.get(symbol)).toBe(flagship.id);
  expect(references.get("AMZN")).toBe(aws.id);
  expect(references.get("MSFT")).toBe(azure.id);
  expect(references.get("AMD")).toBe(amd.id);
  const selectedAmd = gpuEquityRows(rows, "MI355X");
  expect(selectedAmd.find((row) => row.symbol === "AMD")?.reference?.id).toBe(amdNew.id);
  expect(selectedAmd.find((row) => row.symbol === "NVDA")?.reference?.id).toBe(flagship.id);
});
