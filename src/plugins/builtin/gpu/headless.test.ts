import { expect, test } from "bun:test";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { gpuHeadless } from "./headless";
import { gpuBoard, gpuEvent, gpuRow } from "./test-fixture";

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
