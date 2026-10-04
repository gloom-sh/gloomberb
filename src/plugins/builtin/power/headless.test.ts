import { expect, test } from "bun:test";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { powerHeadless } from "./headless";
import { powerBoard, powerPoint, powerProject } from "./test-fixture";

test("headless exports all pages and preserves primary provenance while enforcing a progressing cursor", async () => {
  const requests: number[] = [];
  const ctx = createTestHeadlessContext();
  ctx.apiClient.getCloudPowerBoard = async (query) => { requests.push(query!.offset ?? 0); return powerBoard(query!.offset
    ? { projects: [powerProject({ id: "test:second" })], total: 2 }
    : { hasMore: true, nextOffset: 1, total: 2 }); };
  const report = await powerHeadless.load(createTestHeadlessArgs(), ctx);
  expect(requests).toEqual([0, 1]);
  expect(report.sections[0]!.rows).toHaveLength(2);
  expect(report.sections[0]!.rows![0]!.sourceUrl).toBe("https://example.org/queue.csv");
  ctx.apiClient.getCloudPowerBoard = async () => powerBoard({ hasMore: true, nextOffset: 1, total: 2 });
  await expect(powerHeadless.load(createTestHeadlessArgs(), ctx)).rejects.toThrow("pagination did not advance");
});

test("load classification and benchmark flags use the same tab scope as the pane, and previews do not page", async () => {
  const ctx = createTestHeadlessContext(); let filter: unknown;
  ctx.apiClient.getCloudPowerBoard = async (query) => { filter = query; return powerBoard({ access: "preview", total: 30,
    locked: { projects: 29, aggregates: 0, rates: 0, exposure: 0 } }); };
  const result = await powerHeadless.load(createTestHeadlessArgs({ argument: "NEE:XNYS", options: { tab: "loads", loadClass: "datacenter", historical: true, fuel: "gas" } }), ctx);
  expect(filter).toMatchObject({ kind: "load", loadClass: "datacenter", historical: false, symbol: "NEE:XNYS" });
  expect(filter).not.toHaveProperty("fuel");
  expect(result.complete).toBe(false);
  expect(result.sections[0]!.rows).toHaveLength(1);
});

test("history exports traverse pages and retain the published period and source URL", async () => {
  const ctx = createTestHeadlessContext(); const offsets: number[] = [];
  ctx.apiClient.getCloudPowerBoard = async () => powerBoard();
  ctx.apiClient.getCloudPowerHistory = async (query) => {
    const offset = query?.offset ?? 0; offsets.push(offset);
    return { generatedAt: "2026-10-04", access: "full", locked: 0, hasMore: offset === 0, nextOffset: offset === 0 ? 1 : null,
      points: [powerPoint({ basis: "published", historical: true, period: offset ? "2024" : "2025" })] };
  };
  const result = await powerHeadless.load(createTestHeadlessArgs({ options: { tab: "history", historical: true } }), ctx);
  expect(offsets).toEqual([0, 1]);
  expect(result.sections[0]!.rows).toHaveLength(2);
  expect(result.sections[0]!.rows![0]).toMatchObject({ basis: "published", period: "2025", sourceUrls: ["https://example.org/queue.csv"] });
});
