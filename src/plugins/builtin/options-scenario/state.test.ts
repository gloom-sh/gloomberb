import { describe, expect, test } from "bun:test";
import { parseLegs, validatePosition, validateScenarioInputs, type ScenarioPosition } from "./model";
import { parseScenarioInputFields, restoreSavedStrategies, type ScenarioInputFields } from "./state";

const position: ScenarioPosition = { symbol: "AAPL", currency: "USD", spot: 100, rate: 0.04, dividendYield: 0,
  asOf: Date.UTC(2026, 8, 22), legs: [] };
const fields: ScenarioInputFields = { spot: "100", rate: "4", dividendYield: "0", currency: "usd",
  asOf: "2026-09-22T00:00:00Z", spotRange: "20" };

describe("builder input boundary", () => {
  test("an empty builder still validates every assumption before the first leg is added", () => {
    expect(validateScenarioInputs(position)).toBeNull();
    expect(validatePosition(position)).toContain("at least one");
    for (const patch of [{ spot: NaN }, { rate: NaN }, { dividendYield: Infinity }, { currency: "" }, { asOf: NaN }]) {
      expect(validateScenarioInputs({ ...position, ...patch })).not.toBeNull();
    }
    expect(parseScenarioInputFields(position, fields, null)).toEqual({ position,
      controls: { date: position.asOf, volShift: 0, spotRange: 0.2 } });
  });

  test("empty and nonfinite fields, normalized calendar dates, and missing units cannot be saved", () => {
    const invalid: Partial<ScenarioInputFields>[] = [{ spot: "" }, { spot: "NaN" }, { rate: "" },
      { dividendYield: "Infinity" }, { rate: "0x10" }, { currency: " " }, { asOf: "2026-02-30T12:00:00Z" },
      { asOf: "2026-09-22T12:00:00" }, { asOf: "" }, { spotRange: "" }, { spotRange: "NaN" }, { spotRange: "0" }, { spotRange: "301" }];
    for (const patch of invalid) expect(() => parseScenarioInputFields(position, { ...fields, ...patch }, null)).toThrow();
  });

  test("changing the origin retains vol assumptions and clamps selected date to the supported horizon", () => {
    const controls = { date: Date.UTC(2026, 8, 23), volShift: -0.02, spotRange: 0.4 };
    const later = parseScenarioInputFields(position, { ...fields, asOf: "2026-10-01" }, controls);
    expect(later.controls).toEqual({ date: Date.UTC(2026, 9, 1), volShift: -0.02, spotRange: 0.2 });
    const withLeg = { ...position, legs: parseLegs("call,100,2026-12-18,1,5,25") };
    const outOfBounds = parseScenarioInputFields(withLeg, fields, { ...controls, date: Date.UTC(2027, 0, 1) });
    expect(outOfBounds.controls.date).toBe(Date.UTC(2026, 11, 18, 21));
  });
});

describe("saved strategy restoration", () => {
  const saved = { id: "one", name: "Call spread", position: { ...position, exchange: "NASDAQ",
    legs: parseLegs("call,100,2026-12-18,1,5,25;call,110,2026-12-18,-1,2,25") },
  controls: { date: Date.UTC(2026, 9, 1), volShift: 0.01, spotRange: 0.2 } };

  test("JSON restart restoration keeps historical inputs independent from subsequent edits", () => {
    const disk = JSON.parse(JSON.stringify([saved]));
    const restored = restoreSavedStrategies(disk);
    expect(restored.warnings).toEqual([]);
    expect(restored.strategies).toEqual([saved]);
    restored.strategies[0]!.position.legs[0]!.quantity = 5;
    restored.strategies[0]!.controls.volShift = 0.03;
    expect(restoreSavedStrategies(disk).strategies).toEqual([saved]);
    expect(saved.position.legs[0]!.quantity).toBe(1);
  });

  test("skips damaged entries and duplicate ids while keeping valid saved strategies recoverable", () => {
    const restored = restoreSavedStrategies([null, {}, saved, { ...saved },
      { ...saved, id: "badControls", controls: { ...saved.controls, date: "2026-10-01" } },
      { ...saved, id: "badPosition", position: { ...saved.position, spot: null } }]);
    expect(restored.strategies).toEqual([saved]);
    expect(restored.warnings).toHaveLength(5);
    expect(restoreSavedStrategies({})).toMatchObject({ strategies: [] });
  });
});
