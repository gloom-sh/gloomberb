import { screenFixture as payload } from "./test-fixture";
import { expect, test } from "bun:test";
import type { ScreenSnapshot } from "../../../api-client/equity-screener";
import { fetchScreen } from "./client";
import {
  appendScreenPage,
  criterionText,
  DEFAULT_SCREEN,
  formatScreenValue,
  metricDate,
  parseCriterion,
  parseThreshold,
  resultFields,
  parseScreenDefinition,
  validateScreenPayload,
} from "./model";
const field = {
  id: "trailingPE" as const,
  label: "P/E",
  kind: "number" as const,
  unit: "x",
  description: "",
  operators: ["gte", "between", "present"] as const,
};

test("criteria preserve zero and finite bounds, reject blank, currency ambiguity and observed-subset absence claims", () => {
  expect(
    parseCriterion({ ...field, operators: [...field.operators] }, "gte", "0"),
  ).toEqual({ field: "trailingPE", op: "gte", value: 0 });
  expect(() =>
    parseCriterion({ ...field, operators: [...field.operators] }, "gte", ""),
  ).toThrow("finite");
  expect(() =>
    parseCriterion(
      { ...field, operators: [...field.operators] },
      "between",
      "20,10",
    ),
  ).toThrow("ascending");
  expect(() =>
    parseScreenDefinition({ ...DEFAULT_SCREEN, currency: null }),
  ).toThrow("currency");
  expect(() =>
    parseScreenDefinition({
      ...DEFAULT_SCREEN,
      criteria: [{ field: "insiderPurchases90d", op: "eq", value: 0 }],
    }),
  ).toThrow("supported operator");
});
test("boundaries reject fabricated dates and percentiles; pagination cannot cross snapshots", () => {
  const data = payload();
  expect(validateScreenPayload(data)).toBe(data);
  data.rows[0]!.metrics.price.value = 1;
  data.rows[0]!.metrics.price.state = "available";
  expect(() => validateScreenPayload(data)).toThrow("price");
  data.rows[0]!.metrics.price.asOf = "2026-09-22";
  data.rows[0]!.metrics.price.percentile.value = 101;
  expect(() => validateScreenPayload(data)).toThrow("price");
  const dated = payload();
  dated.snapshot!.assembledAt = null as unknown as ScreenSnapshot["assembledAt"];
  expect(() => validateScreenPayload(dated)).toThrow("snapshot identity");
  const undated = payload();
  undated.rows[0]!.metrics.marketCap.value = 12;
  undated.rows[0]!.metrics.marketCap.state = "partial";
  undated.rows[0]!.metrics.marketCap.observedAt = "2026-09-22T12:00:00Z";
  expect(validateScreenPayload(undated).rows[0]!.metrics.marketCap.asOf).toBeNull();
  const next = payload();
  next.snapshot!.id = "two";
  expect(() => appendScreenPage(payload(), next)).toThrow("snapshot changed");
  expect(appendScreenPage(payload(), payload()).rows).toHaveLength(1);
});

test("query boundary rejects valid rows from different criteria", async () => {
  const response = payload();
  response.definition.criteria = [];
  await expect(fetchScreen(DEFAULT_SCREEN, null, undefined, {
    queryCloudEquityScreen: async () => response,
  })).rejects.toThrow("requested criteria");
});

test("thresholds accept scale suffixes and reject anything else", () => {
  expect(parseThreshold("10B")).toBe(10_000_000_000);
  expect(parseThreshold("1.5t")).toBe(1_500_000_000_000);
  expect(parseThreshold("-0.5")).toBe(-0.5);
  expect(parseThreshold("1e6")).toBe(1_000_000);
  expect(parseThreshold("10 B")).toBeNull();
  expect(parseThreshold("ten")).toBeNull();
  expect(criterionText({ field: "marketCap", op: "gte", value: 10_000_000_000 })).toBe("Market cap >= 10B");
  expect(criterionText({ field: "trailingPE", op: "between", value: [0, 25] })).toBe("Trailing P/E between 0, 25");
});

test("values keep sign, scale and missing distinct from zero", () => {
  expect(formatScreenValue("marketCap", 5_547_531_698_176)).toBe("5.55T");
  expect(formatScreenValue("revenueGrowthPercent", 65.47)).toBe("+65.5");
  expect(formatScreenValue("revenueGrowthPercent", 0)).toBe("0.0");
  expect(formatScreenValue("insiderSales90d", 20)).toBe("20");
  expect(formatScreenValue("trailingPE", null)).toBe("--");
});

test("undated provider values show their collection date, never an invented source date", () => {
  const base = payload().rows[0]!.metrics.trailingPE;
  expect(metricDate({ ...base, asOf: "2026-08-31", observedAt: "2026-09-22T12:00:00Z" })).toEqual({ text: "2026-08-31", collected: false });
  expect(metricDate({ ...base, value: 10, asOf: null, observedAt: "2026-09-22T12:00:00Z" })).toEqual({ text: "2026-09-22", collected: true });
  expect(metricDate({ ...base, value: null, asOf: null, observedAt: null })).toEqual({ text: "--", collected: false });
});

test("result columns lead with the focus metric and the screen's criteria; money needs a currency", () => {
  const definition = parseScreenDefinition({
    version: 1,
    currency: "USD",
    criteria: [{ field: "operatingMarginPercent", op: "gte", value: 20 }, { field: "sector", op: "in", value: ["Technology"] }],
    sort: { field: "trailingPE", direction: "asc" },
  });
  expect(resultFields(definition, "trailingPE").slice(0, 3)).toEqual(["trailingPE", "operatingMarginPercent", "marketCap"]);
  expect(resultFields({ ...definition, currency: null }, "trailingPE")).not.toContain("price");
});
