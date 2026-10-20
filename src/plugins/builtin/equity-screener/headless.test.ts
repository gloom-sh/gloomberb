import { expect, test } from "bun:test";
import { KPI_FIELDS } from "../../../api-client/equity-screener";
import { isProLock } from "../../../cli/pane-functions/access-gate";
import { MAX_TOOL_RESULT_BYTES } from "../cloud/askg/protocol";
import { equityScreenerHeadless } from "./headless";
import { parseScreenDefinition } from "./model";
import { screenFixture } from "./test-fixture";

test("a full page with more matches is neither an error nor too large for an Ask Gloom tool result", async () => {
  const data = screenFixture();
  const row = data.rows[0]!;
  data.rows = Array.from({ length: 100 }, (_, index) => ({ ...row, symbol: `S${index}` }));
  // Sparse fields make every real payload "partial"; that is not a failure.
  Object.assign(data, { status: "partial", nextCursor: "next", universe: { ...data.universe, covered: 700, matched: 680 } });
  const apiClient = { equityScreener: async () => structuredClone(data) };
  const result = await equityScreenerHeadless.load({ argument: undefined, options: {} } as never, { apiClient } as never);
  expect(result.errors).toEqual([]);
  expect(result.complete).toBe(false);
  expect(result.metadata).toMatchObject({ matched: 680, returned: 100, hasMore: true, notices: ["Top 100 of 680 matches; narrow the criteria to see the rest."] });
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(MAX_TOOL_RESULT_BYTES);

  data.warnings = ["Bounded scan: some listings were not evaluated."];
  const bounded = await equityScreenerHeadless.load({ argument: undefined, options: {} } as never, { apiClient } as never);
  expect(bounded.errors).toEqual(data.warnings);
});

test("ATR% can be the metric, and the help says what it is and that IV rank is a rank", async () => {
  const data = screenFixture();
  data.rows[0]!.metrics.atrPercent = { ...data.rows[0]!.metrics.atrPercent, value: 3.456, unit: "%", asOf: "2026-09-21", state: "available", scope: "derived" };
  const apiClient = { equityScreener: async () => structuredClone(data) };
  const result = await equityScreenerHeadless.load({ argument: undefined, options: { metric: "atrPercent" } } as never, { apiClient } as never);
  const section = result.sections![0]!;
  expect(section.columns!.find((column) => column.key === "value")!.header).toBe("ATR%");
  expect(section.rows![0]).toMatchObject({ value: "3.5", unit: "%", asOf: "2026-09-21", state: "available" });
  expect(equityScreenerHeadless.options.find((option) => option.key === "metric")!.values).toContainEqual({ value: "atrPercent" });
  const limitations = equityScreenerHeadless.discovery!.limitations!.join(" ");
  expect(limitations).toContain("ATR% is the 14-session average true range as a percent of the last close");
  expect(limitations).toContain("IV rank is a rank, not an IV percentile");
});

test("the catalog's example definition passes the real validator, and a bad one names the part and the operators", () => {
  const option = equityScreenerHeadless.options.find((candidate) => candidate.key === "definition")!;
  // The shell quoting is the catalog's: the JSON sits between single quotes.
  const json = /^--definition '(.+)'$/.exec(option.example!)![1]!;
  const definition = parseScreenDefinition(JSON.parse(json));
  expect(definition.criteria.map((criterion) => criterion.op)).toEqual(["in", "gte", "between"]);
  expect(option.normalize!(json)).toBe(json);
  expect(() => option.normalize!(JSON.stringify({ ...definition, criteria: [{ field: "industry", op: "eq", value: "Gold" }] })))
    .toThrow(/criteria\[0\] \(industry\): op "eq" is not supported: industry takes in, present, missing\. The example in gloomberb catalog EQS/);
  expect(() => option.normalize!('{"version":1}')).toThrow(/criteria is missing.*sort is missing.*currency is missing/);
});

test("a KPI the server holds back from Free says why once, in KPIS's words; a Pro KPI with gaps says what a gap is", async () => {
  // The server leaves KPI and guidance fields out of every row for a caller without Gloom Pro.
  const free = screenFixture();
  for (const row of free.rows) for (const field of KPI_FIELDS) delete (row.metrics as Partial<typeof row.metrics>)[field];
  const load = (data: typeof free) => equityScreenerHeadless.load({ argument: undefined, options: { metric: "kpiBacklog" } } as never,
    { apiClient: { equityScreener: async () => structuredClone(data) } } as never);
  const locked = await load(free);
  expect(locked.errors).toEqual(["The free screener shows no KPI values; Gloom Pro shows each company's Backlog."]);
  expect(isProLock(locked.errors![0]!)).toBe(true);
  expect(locked.sections![0]!.rows![0]).toMatchObject({ value: "--", state: "locked" });
  expect(locked.notes).toBeUndefined();

  const pro = await load(screenFixture());
  expect(pro.errors).toEqual([]);
  expect(pro.sections![0]!.rows![0]).toMatchObject({ state: "unavailable" });
  expect(pro.notes).toEqual(["1 of 1 row has no Backlog. Coverage follows available company disclosures; missing data is not zero."]);
});
