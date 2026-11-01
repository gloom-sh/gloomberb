import { expect, test } from "bun:test";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { gpuHeadless } from "./headless";
import { gpuBoard, gpuEvent, gpuRow, gpuSettle } from "./test-fixture";

test("exports preserve archive evidence and effective dates while a preview stays incomplete", async () => {
  const ctx = createTestHeadlessContext();
  const access = { tier: "preview" as const, preview: true, locked: true };
  const point = gpuRow({ provenance: "archive", observedAt: "2024-03-01T00:00:00.000Z", effectiveAt: "2024-01-01T00:00:00.000Z",
    evidenceUrl: "https://web.archive.org/web/20240301id_/https://example.com/prices", sourceUrl: "https://example.com/prices" });
  ctx.apiClient.getCloudGpuBoard = async () => gpuBoard({ access });
  ctx.apiClient.getCloudGpuHistory = async () => ({ generatedAt: point.observedAt, access, points: [point], effectivePoints: [] });
  const history = await gpuHeadless.load(createTestHeadlessArgs({ options: { tab: "history" } }), ctx);
  expect(history.complete).toBe(false);
  expect(history.sections[0]!.rows![0]).toMatchObject({ observedAt: point.observedAt, effectiveAt: point.effectiveAt,
    provenance: "archive", provenanceLabel: "archived page, reconstructed", evidenceUrl: point.evidenceUrl, sourceUrl: point.sourceUrl });
  ctx.apiClient.getCloudGpuEvents = async () => ({ generatedAt: point.observedAt, access,
    events: [gpuEvent({ ...point, origin: "observed", kind: "availability", oldAvailability: "unavailable", newAvailability: "available" })] });
  const changes = await gpuHeadless.load(createTestHeadlessArgs({ options: { tab: "changes" } }), ctx);
  expect(changes.complete).toBe(false);
  expect(changes.sections[0]!.rows![0]).toMatchObject({ date: point.observedAt, effectiveAt: point.effectiveAt,
    provenanceLabel: "archived page, reconstructed", oldAvailability: "unavailable", newAvailability: "available" });
});

test("a GPU the free board leaves out reads from its own free preview, printed to the cent with its moves left to Pro", async () => {
  const ctx = createTestHeadlessContext();
  const access = { tier: "preview" as const, preview: true, locked: true };
  ctx.apiClient.getCloudGpuBoard = async () => gpuBoard({ access, rows: [gpuRow({ gpuModel: "A10", skuKey: "a10-pcie-24", memoryGb: 24, formFactor: "PCIe" })] });
  const asked: unknown[] = [];
  ctx.apiClient.getCloudGpuHistory = async (query) => {
    asked.push(query);
    return { generatedAt: "2026-10-03T19:01:00.000Z", access, effectivePoints: [],
      points: [gpuRow({ source: "aggregate", skuKey: "neocloud:H100:80:SXM", provider: "Neocloud list index", providerClass: "aggregate", pricePerGpuHr: 4.00083333333 })] };
  };
  const report = await gpuHeadless.load(createTestHeadlessArgs({ argument: "h-100", options: { tab: "board" } }), ctx);
  expect(asked).toEqual([{ gpuModel: "H100", limit: 10 }]);
  const section = report.sections[0]!;
  const row = section.rows![0]!;
  const cell = (key: string) => section.columns!.find((column) => column.key === key)!.format!(row[key], row);
  expect([cell("price"), cell("change7d"), cell("observedAt")]).toEqual(["4.00", "Pro", "2026-10-03 19:00 UTC"]);
  // A reference index's daily figure is stamped at 00:00 UTC: a day, beside the observations that have a time.
  const stamped = (observedAt: string) => section.columns!.find((column) => column.key === "observedAt")!.format!(observedAt, row);
  expect([stamped("2026-10-24T00:00:00.000Z"), stamped("2026-10-24T00:01:00.000Z")]).toEqual(["2026-10-24", "2026-10-24 00:01 UTC"]);
  expect(report.complete).toBe(false);
  // What the free view leaves to Pro prints on the report's Pro line, not as a note.
  expect(report.errors).toEqual(["Free shows the latest rows of H100, which the free board leaves out. Gloom Pro adds every provider and the 1D, 7D and 30D moves."]);
  expect(report.notes).toBeUndefined();
  await expect(gpuHeadless.load(createTestHeadlessArgs({ argument: "X100" }), ctx)).rejects.toThrow(/No GPU matches "X100"\. GPUs: H100, .*A10\./);
});

test("the board report leads with Gloom's daily settle of the GPU asked for, a day with no settle included", async () => {
  const ctx = createTestHeadlessContext();
  ctx.apiClient.getCloudGpuBoard = async () => gpuBoard({ settles: [gpuSettle(), gpuSettle({ id: "12", formFactor: "PCIe", status: "no-settle", pricePerGpuHr: null }),
    gpuSettle({ id: "13", gpuModel: "B200", memoryGb: null })] });
  const report = await gpuHeadless.load(createTestHeadlessArgs({ argument: "H100", options: { tab: "board" } }), ctx);
  const [settle, board] = report.sections;
  expect([settle!.title, board!.title]).toEqual(["Gloom daily settle", "GPU rental prices"]);
  const cells = settle!.rows!.map((row) => settle!.columns!.map((column) => column.format ? column.format(row[column.key], row) : String(row[column.key])));
  expect(cells).toEqual([
    ["H100 80GB SXM", "settled", "2.99", "-1.2%", "-", "-", "2026-10-02 20:00 UTC"],
    ["H100 80GB PCIe", "no settle", "-", "-1.2%", "-", "-", "2026-10-02 20:00 UTC"],
  ]);
});
