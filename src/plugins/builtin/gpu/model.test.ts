import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { equityFiveDayReturn, gpuAxisLabels, gpuBoardSections, gpuChangeWindows, gpuEquityRows, gpuHistorySeries, gpuHistoryChart, gpuHistoryViewport, gpuEventDate, gpuEventSections, gpuPricePeriods, gpuPriceLadder, gpuShortSource, gpuSource, gpuSparklineSeries } from "./model";
import { gpuEvent, gpuRow } from "./test-fixture";

describe("GPU observation charts", () => {
  test("step lines and markers use only the selected SKU's real observation dates, preserving archive provenance", () => {
    const row = gpuRow();
    const points = [
      gpuRow({ observedAt: "2026-10-03T19:00:00.000Z", pricePerGpuHr: 6.98 }),
      gpuRow({ observedAt: "2026-10-01T19:00:00.000Z", effectiveAt: "2020-01-01T00:00:00.000Z", provenance: "archive", pricePerGpuHr: 7 }),
      gpuRow({ observedAt: "2026-10-02T19:00:00.000Z", provenance: "official-history", pricePerGpuHr: 6.98 }),
      gpuRow({ skuKey: "h100-pcie-80", observedAt: "2025-01-01T00:00:00.000Z", pricePerGpuHr: 2 }),
      gpuRow({ source: "aws-list", observedAt: "2026-10-02T19:00:00.000Z", pricePerGpuHr: 10 }),
    ];
    const [line, observed, archived] = gpuHistorySeries(row, points, "#ffffff", "#00ff00");
    expect(line).toMatchObject({ style: "step", interpolation: "step-after", unit: "$/GPU-hr" });
    expect(line!.timeBasis).toBeUndefined();
    expect(line!.points.map((point) => [point.date.toISOString(), point.value])).toEqual([
      ["2026-10-01T19:00:00.000Z", 7], ["2026-10-02T19:00:00.000Z", 6.98], ["2026-10-03T19:00:00.000Z", 6.98],
    ]);
    expect(observed!.points.map((point) => point.date.toISOString())).toEqual(["2026-10-02T19:00:00.000Z", "2026-10-03T19:00:00.000Z"]);
    expect(archived).toMatchObject({ label: "Archived", style: "points", color: "#00ff00" });
    expect(archived!.points.map((point) => point.date.toISOString())).toEqual(["2026-10-01T19:00:00.000Z"]);
    expect(points[0]!.observedAt).toBe("2026-10-03T19:00:00.000Z");
  });

  test("one or two observations remain collecting even when another SKU has a long history", () => {
    const row = gpuRow();
    const own = [1, 2].map((day) => gpuRow({ observedAt: `2026-10-0${day}T00:00:00.000Z` }));
    const other = [1, 2, 3].map((day) => gpuRow({ skuKey: "other", observedAt: `2026-10-0${day}T00:00:00.000Z` }));
    for (const length of [0, 1, 2]) expect(gpuHistorySeries(row, [...own.slice(0, length), ...other], "#fff", "#0f0")).toEqual([]);
  });

  test("the viewport starts at the first plotted point, including older peers, with bounded trailing padding", () => {
    const row = gpuRow();
    const peer = gpuRow({ source: "aggregate-hyperscaler", provider: "Hyperscaler list index", providerClass: "aggregate" });
    const own = [0, 1, 2].map((hour) => gpuRow({ observedAt: `2026-10-03T${19 + hour}:00:00.000Z` }));
    const chart = gpuHistoryChart([row], own, { selected: "#fff", marker: "#0f0" });
    expect(gpuHistoryViewport(chart)).toEqual({ start: new Date(own[0]!.observedAt), end: new Date("2026-10-03T21:06:00.000Z") });
    const peers = [1, 2, 3].map((day) => gpuRow({ ...peer, observedAt: `2024-10-0${day}T00:00:00.000Z` }));
    const comparison = gpuHistoryChart([row, peer], [...own, ...peers], { selected: "#fff", marker: "#0f0" });
    expect(comparison.filter((series) => series.style === "points").flatMap((series) => series.points)).toHaveLength(3);
    expect(gpuHistoryViewport(comparison)).toEqual({ start: new Date(peers[0]!.observedAt), end: new Date("2026-10-04T21:00:00.000Z") });
    expect(gpuHistoryViewport([])).toBeUndefined();
  });

  test("equal prices do not merge archive records into live observations or extend beyond the final observation", () => {
    const points = [
      gpuRow({ observedAt: "2024-01-01T00:00:00.000Z", provenance: "archive" }),
      gpuRow({ observedAt: "2024-02-01T00:00:00.000Z", provenance: "archive" }),
      gpuRow({ observedAt: "2026-10-03T00:00:00.000Z" }),
      gpuRow({ observedAt: "2026-10-04T00:00:00.000Z" }),
    ];
    const periods = gpuPricePeriods(points);
    expect(periods).toHaveLength(2);
    expect(periods[0]).toMatchObject({ from: points[2]!.observedAt, to: points[3]!.observedAt, provenance: "live", change: 0 });
    expect(periods[1]).toMatchObject({ from: points[0]!.observedAt, to: points[2]!.observedAt, provenance: "archive" });
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
    source: "aggregate-neocloud", provider: "Neocloud list index", providerClass: "aggregate",
    skuKey: "h100-sxm-80", stats: { n: 6, min: 2.5, max: 6 }, change7d: -3,
  });
  const pcie = gpuRow({ ...flagship, id: undefined, skuKey: "h100-pcie-80", formFactor: "PCIe", stats: { n: 1, min: 2, max: 2 }, change7d: 8 });
  const hyperscaler = gpuRow({ source: "aggregate-hyperscaler", provider: "Hyperscaler list index", providerClass: "aggregate", stats: { n: 9, min: 4, max: 10 } });
  const azure = gpuRow();
  const aws = gpuRow({ source: "aws-list", provider: "AWS", change7d: 2 });
  const amd = gpuRow({ source: "aggregate-neocloud", provider: "Neocloud list index", providerClass: "aggregate", gpuModel: "MI300X", skuKey: "mi300x-oam-192", formFactor: "OAM", memoryGb: 192 });
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

test("provider-class rows read as list indexes whether the server still says list median or already says list index", () => {
  for (const provider of ["Hyperscaler list median", "Hyperscaler list index"]) {
    const row = gpuRow({ source: "aggregate-hyperscaler", provider, providerClass: "aggregate" });
    expect(gpuSource(row)).toBe("Hyperscaler list index");
    expect(gpuShortSource(row)).toBe("Hyperscaler index");
  }
  expect(gpuShortSource(gpuRow({ source: "aggregate-neocloud", provider: "Neocloud list median", providerClass: "aggregate" }))).toBe("Neocloud index");
  expect(gpuShortSource(gpuRow({ source: "vast", provider: "Marketplace asks", providerClass: "marketplace", basis: "ask" }))).toBe("Marketplace median");
});

test("equities find the neocloud index under either server label instead of falling back to the first aggregate", () => {
  const hyperscaler = gpuRow({ source: "aggregate-hyperscaler", provider: "Hyperscaler list index", providerClass: "aggregate", skuKey: "h", stats: { n: 9, min: 4, max: 10 } });
  for (const provider of ["Neocloud list index", "Neocloud list median"]) {
    const neocloud = gpuRow({ source: "aggregate-neocloud", provider, providerClass: "aggregate", skuKey: "n", formFactor: "PCIe", stats: { n: 2, min: 3, max: 4 } });
    const nvda = gpuEquityRows([hyperscaler, neocloud], "H100").find((row) => row.symbol === "NVDA");
    expect(nvda?.reference?.id).toBe(neocloud.id);
  }
});

describe("GPU board layout", () => {
  test("sections run by model then basis, indexes and medians lead each section, and the licensed index never reaches the board", () => {
    const rows = [
      gpuRow({ source: "shadeform", provider: "lambda", providerClass: "marketplace", basis: "ask", skuKey: "lambda-ask" }),
      gpuRow({ source: "vast", provider: "Marketplace asks", providerClass: "marketplace", basis: "ask", skuKey: "vast-ask" }),
      gpuRow({ source: "aws-list", provider: "AWS", skuKey: "aws" }),
      gpuRow({ source: "aggregate", provider: "Neocloud list index", providerClass: "aggregate", skuKey: "neo" }),
      gpuRow({ source: "aws-spot", provider: "AWS", basis: "spot", skuKey: "aws-spot" }),
      gpuRow({ source: "licensed", provider: "Index", basis: "index", skuKey: "index" }),
      gpuRow({ gpuModel: "B200", source: "aws-list", provider: "AWS", skuKey: "b200" }),
    ];
    const one = gpuBoardSections(rows, "H100");
    expect(one.map((section) => [section.label, section.rows.map((row) => row.skuKey)])).toEqual([
      ["List price", ["neo", "aws"]], ["Provider-declared spot", ["aws-spot"]], ["Ask", ["vast-ask", "lambda-ask"]],
    ]);
    expect(gpuBoardSections(rows).map((section) => section.label)).toEqual(["H100 List price", "H100 Provider-declared spot", "H100 Ask", "B200 List price"]);
  });

  test("change windows appear only once a figure exists, so a young history reads as new instead of columns of dashes", () => {
    expect(gpuChangeWindows([gpuRow(), gpuRow({ skuKey: "other" })])).toEqual([]);
    expect(gpuChangeWindows([gpuRow({ change1d: 0 }), gpuRow({ skuKey: "other", change30d: -2 })])).toEqual(["change1d", "change30d"]);
  });

  test("sparklines fetch only one model's medians, and nothing before a change figure exists", () => {
    const median = gpuRow({ skuKey: "median", providerClass: "aggregate" });
    const rows = [median, ...Array.from({ length: 40 }, (_, index) => gpuRow({ skuKey: `p${index}` }))];
    expect(gpuSparklineSeries(rows, "H100")).toEqual([]);
    const moved = rows.map((row, index) => index === 3 ? { ...row, change1d: 1 } : row);
    expect(gpuSparklineSeries(moved, "H100")).toEqual([median.id]);
    expect(gpuSparklineSeries(moved, "")).toEqual([]);
  });

  test("the price ladder leaves provider medians out, so their constituents are not counted twice", () => {
    const list = [3, 4, 5, 10].map((price, index) => gpuRow({ skuKey: `p${index}`, pricePerGpuHr: price }));
    const median = gpuRow({ skuKey: "median", providerClass: "aggregate", pricePerGpuHr: 4.5 });
    const [ladder] = gpuPriceLadder([...list, median, gpuRow({ skuKey: "b", gpuModel: "B200", pricePerGpuHr: 99 })], "H100");
    expect(ladder).toEqual({ basis: "list", n: 4, min: 3, max: 10, p25: 3.75, median: 4.5, p75: 6.25 });
  });

  test("axis labels sit centred on their own values, never repeat, and give way rather than move", () => {
    // A10: list 2.036 and spot 2.19, padded to 1.986..2.24. The 2.19 marker must land left of the $2.2 tick.
    const low = 1.986, high = 2.24, cells = 60;
    const cell = (value: number) => Math.round((value - low) / (high - low) * (cells - 1));
    const labels = gpuAxisLabels(low, high, cells, { left: 15, right: 7 });
    expect(labels.map((label) => label.text)).toEqual(["$2.0", "$2.1", "$2.2"]);
    for (const label of labels) {
      expect(label.ratio).toBeCloseTo((label.value - low) / (high - low), 12);
      expect(label.start + Math.floor(label.text.length / 2)).toBe(cell(label.value));
    }
    expect(cell(2.19)).toBeLessThan(labels[2]!.start + 2);
    // Steps of 0.05 and 0.25 keep the decimals that tell neighbours apart.
    expect(gpuAxisLabels(2, 2.2, 80, { left: 3, right: 3 }).map((label) => label.text)).toEqual(["$2.00", "$2.05", "$2.10", "$2.15", "$2.20"]);
    expect(gpuAxisLabels(0, 1.2, 80, { left: 3, right: 3 }).map((label) => label.text)).toEqual(["$0.00", "$0.25", "$0.50", "$0.75", "$1.00"]);
    // A track too short for every label drops the one that would touch its neighbour and keeps the rest on their values.
    expect(gpuAxisLabels(low, high, 8, { left: 3, right: 3 }).map((label) => [label.text, label.start])).toEqual([["$2.0", -2], ["$2.2", 4]]);
  });

  test("history periods fold unchanged hourly snapshots and measure each move against the previous price", () => {
    const at = (hour: number, price: number) => ({ observedAt: `2026-10-0${1 + Math.floor(hour / 24)}T${String(hour % 24).padStart(2, "0")}:00:00.000Z`, pricePerGpuHr: price });
    const periods = gpuPricePeriods([at(5, 5), at(1, 4), at(2, 4), at(3, 5), at(4, 5)]);
    expect(periods.map((period) => [period.from.slice(11, 13), period.to?.slice(11, 13) ?? null, period.price])).toEqual([["03", "05", 5], ["01", "03", 4]]);
    expect(periods[0]!.change).toBeCloseTo(25);
    expect(periods[1]!.change).toBeNull();
  });
});


test("backfilled observed changes stay on their evidence date while published notices use effective dates", () => {
  const observed = gpuEvent({ origin: "observed", provenance: "archive", observedAt: "2024-03-01T00:00:00.000Z", effectiveAt: "2020-01-01T00:00:00.000Z" });
  const published = gpuEvent({ origin: "published", observedAt: "2026-10-03T00:00:00.000Z", effectiveAt: "2026-10-01T00:00:00.000Z" });
  expect(gpuEventDate(observed)).toBe(observed.observedAt);
  expect(gpuEventDate(published)).toBe(published.effectiveAt!);
  expect(gpuEventSections([observed, published]).map(section => section.label)).toEqual(["Thu, Oct 1, 2026", "Fri, Mar 1, 2024"]);
});
