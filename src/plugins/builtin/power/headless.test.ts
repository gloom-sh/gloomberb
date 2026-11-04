import { expect, test } from "bun:test";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { PowerFilter } from "../../../api-client/power";
import { powerHeadless } from "./headless";
import { powerBoard, powerCoverage, powerPoint, powerProject } from "./test-fixture";

/** A register of `total` records served as the board route serves them: at most 500 a page, from the offset asked. */
function pagedBoard(total: number, asked: Array<{ offset: number; limit: number }>) {
  const rows = Array.from({ length: total }, (_, index) => powerProject({ id: `test:queue-${index}`, capacityMw: total - index }));
  return async (query?: PowerFilter) => {
    const offset = query?.offset ?? 0; const limit = Math.min(query?.limit ?? 100, 500);
    asked.push({ offset, limit });
    const projects = rows.slice(offset, offset + limit); const next = offset + projects.length;
    return powerBoard({ projects, total, hasMore: next < total, nextOffset: next < total ? next : null });
  };
}

test("the report lists one page of the largest records unless --limit or --offset asks for more", async () => {
  const ctx = createTestHeadlessContext(); const asked: Array<{ offset: number; limit: number }> = [];
  ctx.apiClient.getCloudPowerBoard = pagedBoard(1200, asked);
  const first = await powerHeadless.load(createTestHeadlessArgs(), ctx);
  expect(asked).toEqual([{ offset: 0, limit: 500 }]);
  expect(first.sections[0]!.rows).toHaveLength(500);
  expect(first.complete).toBe(true);
  expect(first.metadata).toMatchObject({ total: 1200, offset: 0, nextOffset: 500, filters: { limit: 500, sort: "capacityMw", direction: "desc" } });
  expect(first.notes).toEqual(["Showing 500 of 1,200 records. More: --offset 500, or --limit 1200 for all of them."]);

  asked.length = 0;
  const all = await powerHeadless.load(createTestHeadlessArgs({ options: { limit: 1200 } }), ctx);
  expect(asked).toEqual([{ offset: 0, limit: 500 }, { offset: 500, limit: 500 }, { offset: 1000, limit: 200 }]);
  expect(all.sections[0]!.rows!.map((row) => row.id)).toEqual(Array.from({ length: 1200 }, (_, index) => `test:queue-${index}`));
  expect(all.metadata).toMatchObject({ nextOffset: null, filters: { limit: 1200 } });
  expect(all.notes).toBeUndefined();

  asked.length = 0;
  const page = await powerHeadless.load(createTestHeadlessArgs({ options: { offset: 500, limit: 600 } }), ctx);
  expect(asked).toEqual([{ offset: 500, limit: 500 }, { offset: 1000, limit: 100 }]);
  expect(page.sections[0]!.rows!.map((row) => row.id)).toEqual(Array.from({ length: 600 }, (_, index) => `test:queue-${500 + index}`));
  expect(page.notes![0]).toBe("Showing 501-1,100 of 1,200 records. More: --offset 1100.");

  const past = await powerHeadless.load(createTestHeadlessArgs({ options: { offset: 5000 } }), ctx);
  expect((past.sections[0] as { empty?: string }).empty).toBe("No records past --offset 5000: there are 1,200.");

  // The other tabs list every row, as before, and say the flags did nothing.
  asked.length = 0;
  const outcomes = await powerHeadless.load(createTestHeadlessArgs({ options: { tab: "outcomes", limit: 5, offset: 7 } }), ctx);
  expect(asked).toEqual([{ offset: 0, limit: 500 }]);
  expect(outcomes.warnings).toEqual(["--limit and --offset apply to the queue, loads and capacity tabs only; ignored here."]);
});

test("a page that does not advance the cursor fails instead of truncating the records", async () => {
  const ctx = createTestHeadlessContext();
  ctx.apiClient.getCloudPowerBoard = async (query) => powerBoard(query?.offset
    ? { projects: [powerProject({ id: "test:second" })], hasMore: true, nextOffset: 1, total: 3 }
    : { hasMore: true, nextOffset: 1, total: 3 });
  await expect(powerHeadless.load(createTestHeadlessArgs({ options: { limit: 3 } }), ctx)).rejects.toThrow("pagination did not advance");
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

test("the report prints the pane's columns with the ticker map, and an empty ticker tab says where the ticker's records are", async () => {
  const ctx = createTestHeadlessContext();
  ctx.apiClient.getCloudPowerBoard = async () => powerBoard({ projects: [powerProject(), powerProject({ id: "test:queue-2", entities: [], capacityMw: 1234.56 })], total: 2 });
  const queue = (await powerHeadless.load(createTestHeadlessArgs(), ctx)).sections[0]!;
  expect(queue.columns!.map((column) => column.key)).not.toContain("metrics");
  const cell = (key: string, index: number) => queue.columns!.find((column) => column.key === key)!.format!(queue.rows![index]![key], queue.rows![index]!);
  expect([cell("ticker", 0), cell("ticker", 1), cell("capacityMw", 1)]).toEqual(["NEE", "unmapped", "1,234.6"]);
  const asked: unknown[] = [];
  ctx.apiClient.getCloudPowerBoard = async (query) => {
    asked.push(query);
    return powerBoard({ projects: [], exposure: [], total: query?.kind === "capacity" && query.sourceId === "us-eia860" ? 4 : 0 });
  };
  const utilities = (await powerHeadless.load(createTestHeadlessArgs({ argument: "VST", options: { tab: "utilities" } }), ctx)).sections[0]!;
  expect("empty" in utilities && utilities.empty).toBe("No large-load requests or utility exposure map to VST. VST has 4 generation capacity records (--tab capacity). Sources loaded now: PJM.");
  // Loads are what utilities sum, so they are not counted again.
  expect(asked.filter((query) => (query as { kind?: string }).kind === "load")).toHaveLength(1);
});

test("a company with no rows hears what is loaded, and unavailable queues are a note, not an error", async () => {
  const ctx = createTestHeadlessContext();
  ctx.apiClient.getCloudPowerBoard = async () => powerBoard({ projects: [], total: 0, exposure: [], coverage: [powerCoverage({ records: 8253 }),
    powerCoverage({ id: "us-miso", region: "MISO", status: "failed", reason: "The operator's site does not allow automated downloads.", records: 0 })] });
  const result = await powerHeadless.load(createTestHeadlessArgs({ argument: "VST", options: { tab: "utilities" } }), ctx);
  expect(result.sections[0]!.rows).toEqual([]);
  expect(result.errors).toBeUndefined();
  expect(result.notes).toEqual(["US queues: PJM loaded; MISO not available"]);
  expect((result.sections[0] as { empty?: string }).empty).toMatch(/ Sources loaded now: PJM\.$/);
});
