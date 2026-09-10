import { describe, expect, test } from "bun:test";
import { sharedChartGeometry } from "./chart";

describe("shared chart coordinates", () => {
  test("aligns unequal and irregular histories by their timestamps, including singleton series", () => {
    const result = sharedChartGeometry({ title: "Common dates", series: [
      { name: "Long", unit: "%", points: [{ x: "2026-01-01", y: 0 }, { x: "2026-01-10", y: 10 }, { x: "2026-01-11", y: 11 }] },
      { name: "Short", unit: "%", points: [{ x: "2026-01-10", y: 5 }, { x: "2026-01-11", y: 6 }] },
      { name: "Single", unit: "%", points: [{ x: "2026-01-10", y: 8 }] },
    ] });
    const [long, short, single] = result.panels[0]!.series;
    expect(long!.segments[0]!.map((point) => point.x)).toEqual([20, 884, 980]);
    expect(short!.segments[0]![0]!.x).toBe(884);
    expect(single!.segments[0]![0]!.x).toBe(884);
    expect(result.startLabel).toBe("2026-01-01");
    expect(result.endLabel).toBe("2026-01-11");
  });

  test("keeps gaps, incompatible units and a requested date window", () => {
    const result = sharedChartGeometry({ title: "Units", viewport: { start: "2026-01-01", end: "2026-01-11" }, series: [
      { name: "Price", unit: "USD", points: [{ x: "2026-01-02", y: 100 }, { x: "2026-01-03", y: null }, { x: "2026-01-04", y: 110 }] },
      { name: "Return", unit: "%", points: [{ x: "2026-01-04", y: 1 }] },
    ] });
    expect(result.panels.map((panel) => panel.unit)).toEqual(["USD", "%"]);
    expect(result.panels[0]!.series[0]!.segments).toHaveLength(2);
    expect(result.panels[0]!.min).toBe(100);
    expect(result.panels[0]!.max).toBe(110);
    expect(result.panels[1]!.series[0]!.segments[0]![0]!.x).toBe(308);
  });

  test("uses common numeric and categorical axes for existing share formats", () => {
    for (const inputs of [[1, 10, 11], ["one", "ten", "eleven"]] as const) {
      const result = sharedChartGeometry({ title: "Legacy", series: [
        { name: "A", points: inputs.map((x, y) => ({ x, y })) },
        { name: "B", points: [{ x: inputs[1], y: 1 }] },
      ] });
      expect(result.panels[0]!.series[1]!.segments[0]![0]!.x).toBe(result.panels[0]!.series[0]!.segments[0]![1]!.x);
      expect(result.panels[0]!.unit).toBe("Unit unavailable");
    }
  });
});

test("shared steps retain level changes and empty panels have no numerical evidence", async () => {
  const { sharedChartLinePoints } = await import("./chart");
  const result = sharedChartGeometry({ title: "Known and unknown", series: [
    { name: "Rate", unit: "%", style: "step", points: [{ x: 1, y: 2 }, { x: 2, y: 3 }] },
    { name: "Unavailable price", unit: "USD", points: [{ x: 1, y: null }] },
  ] });
  expect(result.panels[0]!.hasValues).toBe(true);
  expect(sharedChartLinePoints(result.panels[0]!.series[0]!.segments[0]!, "step")).toBe("20,300 980,300 980,20");
  expect(result.panels[1]!.hasValues).toBe(false);
});
