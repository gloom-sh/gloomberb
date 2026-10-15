import { describe, expect, test } from "bun:test";
import { parseFormulaExpression } from "./formula";
import { buildCustomChartPreset } from "./presets";
import { getSelectedPairStudies } from "./studies";

const legs = (expression: string) => parseFormulaExpression(expression)?.legs
  .map(({ text, weight, perBarrel }) => ({ text, weight, perBarrel }));

describe("series formulas", () => {
  test("a number multiplies the series beside it on either side, before the terms add up", () => {
    expect(legs("42*HO=F - CL=F")).toEqual([
      { text: "HO=F", weight: 42, perBarrel: true },
      { text: "CL=F", weight: -1, perBarrel: false },
    ]);
    expect(legs("HO=F*42 - BZ=F")).toEqual([
      { text: "HO=F", weight: 42, perBarrel: true },
      { text: "BZ=F", weight: -1, perBarrel: false },
    ]);
    // A tight minus subtracts after a future, and every number of a term multiplies.
    expect(legs("-3*CL=F+2*42*RB=F-HO=F×42")).toEqual([
      { text: "CL=F", weight: -3, perBarrel: false },
      { text: "RB=F", weight: 84, perBarrel: true },
      { text: "HO=F", weight: -42, perBarrel: true },
    ]);
    // Only a literal 42 is the barrel's gallons: 84 is a count.
    expect(legs("84*RB=F - CL=F")?.[0]).toEqual({ text: "RB=F", weight: 84, perBarrel: false });
    // A minus inside a ticker stays in it.
    expect(legs("2*BRK-B - SPY")?.map(({ text }) => text)).toEqual(["BRK-B", "SPY"]);
  });

  test("only the whole formula, in brackets, is divided by a number", () => {
    const crack = parseFormulaExpression("(2*42*RB=F + 42*HO=F - 3*CL=F)/3");
    expect(crack?.divisor).toBe(3);
    expect(crack?.legs.map(({ weight }) => weight)).toEqual([84, 42, -3]);
    expect(parseFormulaExpression("( 42*HO=F - CL=F ) / 2.5")?.divisor).toBe(2.5);
    expect(parseFormulaExpression("(42*HO=F - CL=F)")?.divisor).toBe(1);
  });

  test("leaves a series, a list or a pair to the parsers that read them", () => {
    for (const expression of ["", "HO=F", "AAPL, MSFT", "GAA/VOO", "BRK-B"]) {
      expect(parseFormulaExpression(expression)).toBeNull();
    }
  });

  test.each([
    ["HO=F*CL=F - BZ=F", "HO=F*CL=F multiplies two series. Each term is one series times numbers, such as 42*HO=F."],
    ["42*HO=F - 5", "5 is a number with no series: each term multiplies one series, such as 42*HO=F."],
    ["42*HO=F/3 - CL=F", "\"HO=F/3\" divides inside the formula. Divide the whole formula by a number in brackets, as in (2*42*RB=F + 42*HO=F - 3*CL=F)/3; chart a ratio of two series as A / B on its own."],
    ["2*(HO=F - CL=F)", "Brackets go around the whole formula only, before an optional divisor: (2*42*RB=F + 42*HO=F - 3*CL=F)/3."],
    ["(42*HO=F - CL=F", "The brackets in \"(42*HO=F - CL=F\" do not pair up."],
    ["(42*HO=F - CL=F)/0", "A formula cannot be divided by 0."],
    ["(42*HO=F - CL=F)/BZ=F", "Divide the whole formula by a number, such as /3, not BZ=F."],
    ["HO=F + CL=F - HO=F", "HO=F appears twice. Write it once with its combined multiplier, such as 2*HO=F."],
    ["42*HO=F - CL=F +", "The formula ends with \"+\"; add the series it applies to."],
    ["42*HO=F - CL=F, AAPL", "A formula charts on its own, not in a list: chart 42*HO=F - CL=F by itself."],
    ["0*HO=F + CL=F", "A multiplier of 0 removes its series; leave the term out instead."],
    ["42*HO=F - CL=F!", "\"CL=F!\" is not a series. Use SYMBOL, SYMBOL:field, FUT:code, UST:maturity, FRED:series, GEO:series or CAP:capability-id:series-id."],
  ])("%s is refused with how to write it", (expression, message) => {
    expect(() => buildCustomChartPreset(expression)).toThrow(message);
  });

  test("a formula charts its legs and one study that weighs them, and a pair stays a pair", () => {
    const spec = buildCustomChartPreset("(2*42*RB=F + 42*HO=F - 3*CL=F)/3");
    expect(spec.series.map((series) => series.source)).toEqual(["RB=F", "HO=F", "CL=F"].map((symbol) => (
      expect.objectContaining({ kind: "security", instrument: { symbol }, fieldId: "market.ohlcv" }))));
    expect(spec.studies).toEqual([expect.objectContaining({
      kind: "formula",
      panelId: "formula",
      inputSeriesIds: spec.series.map(({ id }) => id),
      parameters: { divisor: 3, weight1: 84, perBarrel1: 1, weight2: 42, perBarrel2: 1, weight3: -3 },
    })]);
    expect(spec.panels.map(({ id }) => id)).toContain("formula");
    // The per-gallon legs and the crude read on their own axes.
    expect(spec.series.map(({ axis }) => axis)).toEqual(["auto", "auto", "right"]);
    expect(buildCustomChartPreset("CL=F + BZ=F").series.map(({ axis }) => axis)).toEqual(["auto", "auto"]);
    expect(getSelectedPairStudies(buildCustomChartPreset("HO=F - BZ=F"))).toEqual(["spread"]);
    expect(buildCustomChartPreset("HO=F - BZ=F").studies.some(({ kind }) => kind === "formula")).toBe(false);
  });
});
