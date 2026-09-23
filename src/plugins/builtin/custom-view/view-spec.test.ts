import { describe, expect, test } from "bun:test";
import {
  applyViewProjection,
  formatViewValue,
  normalizeViewSpec,
  parseViewSpec,
  parseViewSpecOr,
  serializeViewSpec,
  validateViewSpec,
  viewColumnDecimals,
} from "./view-spec";

const good = {
  version: 1,
  source: { kind: "inline", pane: "SCR", argument: "sp500", options: { limit: 50, kind: "gainers" } },
  projection: {
    columns: ["symbol", { key: "change", label: "Chg", transform: "percent", align: "right" }],
    filters: [{ key: "change", op: "gt", value: 0.02 }],
    sort: { by: "change", direction: "desc" },
    limit: 20,
  },
  presentation: { title: "Big movers", symbolKey: "symbol" },
};

describe("view spec parsing", () => {
  test("normalizes shorthand columns, defaults, and drops junk", () => {
    const spec = normalizeViewSpec({
      ...good,
      projection: { ...good.projection, columns: [...good.projection.columns, 7, { nope: true }], filter: undefined },
      presentation: { title: "  Big movers ", density: "loud", extra: 1 },
    });
    expect(spec.projection.columns).toEqual([
      { key: "symbol" },
      { key: "change", label: "Chg", transform: "percent", align: "right" },
    ]);
    expect(spec.projection.sort).toEqual({ by: "change", direction: "desc" });
    expect(spec.presentation).toEqual({ title: "Big movers" });
    expect(spec.source).toEqual({ kind: "inline", pane: "SCR", argument: "sp500", options: { limit: 50, kind: "gainers" } });
  });

  test("accepts JSON strings and objects, rejects invalid specs with reasons", () => {
    expect(parseViewSpec(JSON.stringify(good))).not.toBeNull();
    expect(parseViewSpec(good)).not.toBeNull();
    expect(parseViewSpec("{ not json")).toBeNull();
    expect(parseViewSpec({ ...good, version: 2 })).toBeNull();
    expect(parseViewSpec({ ...good, source: { kind: "inline", pane: "" } })).toBeNull();
    const bad = parseViewSpecOr({
      ...good,
      projection: { filters: [{ key: "change", op: "between", value: 1 }, { key: "x", op: "in", value: 3 }], limit: 0 },
    });
    expect("error" in bad ? bad.error : "").toContain("projection.filters.0.op");
    expect("error" in bad ? bad.error : "").toContain("projection.limit");
    expect(() => serializeViewSpec(normalizeViewSpec({ ...good, version: 9 }))).toThrow();
  });

  test("ref sources need an id and carry the team", () => {
    const spec = normalizeViewSpec({ source: { kind: "ref", viewId: "v1", teamId: "org-1" } });
    expect(spec.source).toEqual({ kind: "ref", viewId: "v1", teamId: "org-1" });
    expect(validateViewSpec(normalizeViewSpec({ source: { kind: "ref" } })).valid).toBe(false);
    const warned = validateViewSpec(normalizeViewSpec({ ...good, projection: { columns: ["a", "a"] } }));
    expect(warned.valid).toBe(true);
    expect(warned.warnings.map((entry) => entry.code)).toEqual(["duplicate-key"]);
  });
});

describe("applyViewProjection", () => {
  const rows = [
    { symbol: "AAPL", change: 0.03, sector: "Tech" },
    { symbol: "XOM", change: -0.01, sector: "Energy" },
    { symbol: "NVDA", change: 0.08, sector: "Tech" },
    { symbol: "MSFT", change: 0.025, sector: null },
  ];

  test("filters, sorts, and limits", () => {
    const spec = normalizeViewSpec(good);
    expect(applyViewProjection(rows, spec.projection).map((row) => row.symbol)).toEqual(["NVDA", "AAPL", "MSFT"]);
    expect(applyViewProjection(rows, { ...spec.projection, limit: 1 }).map((row) => row.symbol)).toEqual(["NVDA"]);
    expect(applyViewProjection(rows, spec.projection, { by: "change", direction: "asc" }).map((row) => row.symbol)).toEqual(["MSFT", "AAPL", "NVDA"]);
    expect(applyViewProjection(rows, spec.projection, null).map((row) => row.symbol)).toEqual(["AAPL", "NVDA", "MSFT"]);
  });

  test("supports every operator", () => {
    const run = (op: string, value?: unknown) => applyViewProjection(rows, {
      columns: [],
      filters: [{ key: op === "exists" ? "sector" : op === "contains" ? "symbol" : "change", op: op as never, ...(value === undefined ? {} : { value: value as never }) }],
    }).map((row) => row.symbol);
    expect(run("exists")).toEqual(["AAPL", "XOM", "NVDA"]);
    expect(run("contains", "vd")).toEqual(["NVDA"]);
    expect(run("in", [0.03, 0.08])).toEqual(["AAPL", "NVDA"]);
    expect(run("eq", 0.08)).toEqual(["NVDA"]);
    expect(run("neq", 0.08)).toEqual(["AAPL", "XOM", "MSFT"]);
    expect(run("lte", 0.025)).toEqual(["XOM", "MSFT"]);
    expect(run("gte", 0.03)).toEqual(["AAPL", "NVDA"]);
    expect(run("lt", 0)).toEqual(["XOM"]);
  });
});

describe("formatViewValue", () => {
  test("applies transforms", () => {
    expect(formatViewValue(0.1234, "percent")).toBe("12.34%");
    expect(formatViewValue(1_234_567, "compact")).toBe("1.2M");
    expect(formatViewValue(-3, "abs")).toBe("3");
    expect(formatViewValue(110, "index100", 100)).toBe("110.0");
    expect(formatViewValue(3.14159, undefined)).toBe("3.14");
    expect(formatViewValue("text", "percent")).toBe("text");
    expect(formatViewValue(null, "compact")).toBe("");
  });

  test("reads midnight ISO stamps as dates and gives a numeric column one decimal count", () => {
    expect(formatViewValue("2026-09-01T00:00:00.000Z", undefined)).toBe("2026-09-01");
    expect(formatViewValue("2026-09-01T14:30:00Z", undefined)).toBe("2026-09-01 14:30 UTC");
    const rows = [{ close: 236 }, { close: 232.1 }, { close: null }];
    const decimals = viewColumnDecimals(rows, "close");
    expect(rows.map((row) => formatViewValue(row.close, undefined, undefined, decimals))).toEqual(["236.0", "232.1", ""]);
  });
});
