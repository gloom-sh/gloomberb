import { expect, test } from "bun:test";
import type { GpuHistoryPayload } from "../../../api-client/gpu";
import { fetchGpuHistory } from "./client";
import { gpuHistoryChart, gpuHeadline, gpuReferenceRows, gpuBoardSections } from "./model";
import { gpuRow } from "./test-fixture";

const reference = () => gpuRow({ source: "ref-a", skuKey: "h100-sxm", provider: "Reference index A, H100 SXM",
  providerClass: "aggregate", basis: "reference", provenance: "reference", region: "global", memoryGb: null,
  sourceUrl: null, evidenceUrl: null, provenanceLabel: "Reference index (third party), anonymised" });

test("reference catalog chooses each latest reading without joining our medians or changing published values", () => {
  const points = [reference(), gpuRow({ ...reference(), id: undefined, observedAt: "2026-09-01T00:00:00Z", pricePerGpuHr: 2.123456 }), gpuRow()];
  const rows = gpuReferenceRows(points);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.pricePerGpuHr).toBe(points[0]!.pricePerGpuHr);
  expect(gpuHeadline(rows[0]!)).toBe(false);
  expect(gpuBoardSections([gpuRow(), ...rows], "H100").map(section => section.label)).toEqual(["List price", "Reference"]);
  const history = [1, 2, 3].map(day => gpuRow({ ...reference(), id: undefined, observedAt: `2026-09-0${day}T00:00:00Z`, pricePerGpuHr: 2.123456 + day }));
  const chart = gpuHistoryChart(rows, history, { selected: "#ffffff", marker: "#ff0000" });
  expect(chart[0]!.color).toBe("#879da5");
  expect(chart[0]!.label).toContain("third party, anonymised");
  expect(chart[0]!.points.map(point => point.value)).toEqual(history.map(point => point.pricePerGpuHr));
});

test("reference API boundary refuses links, mislabeled provenance and unrecognised public names", async () => {
  const payload: GpuHistoryPayload = { generatedAt: reference().observedAt, points: [reference()], effectivePoints: [] };
  expect(await fetchGpuHistory({ basis: "reference" }, { getCloudGpuHistory: async () => payload })).toEqual(payload);
  for (const changes of [{ sourceUrl: "https://example.com/private" }, { evidenceUrl: "https://example.com/private" },
    { provenance: "live" }, { source: "unexpected" }, { provider: "Unexpected public name" }]) {
    await expect(fetchGpuHistory({}, { getCloudGpuHistory: async () => ({ ...payload, points: [{ ...reference(), ...changes }] }) as GpuHistoryPayload }))
      .rejects.toThrow("invalid GPU price history");
  }
});
