import { describe, expect, test } from "bun:test";
import { parseFormulaExpression } from "./formula";
import { appendCatalogSuggestion, buildCustomChartPreset, buildEmptyChartPreset, buildPriceChartPreset } from "./presets";
import { getSelectedPairStudies } from "./studies";
import { buildSeriesCatalogSuggestions } from "./series-catalog";
import { seriesCatalogEntry } from "../../../series/registry";
import { FUTURES_SERIES } from "../futures/series";

const legs = (expression: string) => parseFormulaExpression(expression)?.legs
  .map(({ text, weight, perBarrel }) => ({ text, weight, perBarrel }));
const factors = (expression: string) => parseFormulaExpression(expression)?.factors.map(({ text, power }) => ({ text, power }));

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
    expect(legs("2*BRK-B:NYSE - SPY")?.map(({ text }) => text)).toEqual(["BRK-B:NYSE", "SPY"]);
  });

  test("a tight minus subtracts after a listing's exchange or field, unless it spells the field", () => {
    expect(legs("42*HO=F:NYM-CL=F:NYM")).toEqual([
      { text: "HO=F:NYM", weight: 42, perBarrel: true },
      { text: "CL=F:NYM", weight: -1, perBarrel: false },
    ]);
    expect(legs("42*HO=F:NYM:close-CL=F:close")?.map(({ text }) => text)).toEqual(["HO=F:NYM:close", "CL=F:close"]);
    expect(legs("(2*42*RB=F:NYM+42*HO=F:NYM-3*CL=F:NYM)/3")?.map(({ weight }) => weight)).toEqual([84, 42, -3]);
    // Field names are matched without their punctuation, so a hyphen can be part of one.
    expect(legs("2*GC=F:price-sales - SI=F")?.map(({ text }) => text)).toEqual(["GC=F:price-sales", "SI=F"]);
    expect(legs("2*GC=F:free-cash-flow - SI=F")?.map(({ text }) => text)).toEqual(["GC=F:free-cash-flow", "SI=F"]);
  });

  test("only the whole formula, in brackets, is divided by a number", () => {
    const crack = parseFormulaExpression("(2*42*RB=F + 42*HO=F - 3*CL=F)/3");
    expect(crack?.divisor).toBe(3);
    expect(crack?.legs.map(({ weight }) => weight)).toEqual([84, 42, -3]);
    expect(parseFormulaExpression("( 42*HO=F - CL=F ) / 2.5")?.divisor).toBe(2.5);
    expect(parseFormulaExpression("(42*HO=F - CL=F)")?.divisor).toBe(1);
  });

  test("the whole formula in brackets is divided or multiplied by series too, and numbers after it multiply each leg", () => {
    const eur = parseFormulaExpression("(42*HO=F - BZ=F)/EURUSD=X");
    expect(eur?.legs.map(({ text }) => text)).toEqual(["HO=F", "BZ=F"]);
    expect(eur?.factors.map(({ text, power }) => ({ text, power }))).toEqual([{ text: "EURUSD=X", power: -1 }]);
    // Numbers and series chain in any order; a pair written with a slash stays one series.
    expect(parseFormulaExpression("(42*HO=F - BZ=F)/3/EURUSD=X*USDJPY=X")?.divisor).toBe(3);
    expect(factors("(42*HO=F - BZ=F)/3/EURUSD=X*USDJPY=X")).toEqual([{ text: "EURUSD=X", power: -1 }, { text: "USDJPY=X", power: 1 }]);
    expect(factors("(42*HO=F - BZ=F)/EUR/USD")).toEqual([{ text: "EUR/USD", power: -1 }]);
    // Times 7.45 the barrels of a tonne of gasoil go into every leg, as written on each.
    expect(parseFormulaExpression("(42*HO=F - BZ=F)*7.45")?.legs.map(({ weight, perBarrel, perTonne }) => ({ weight, perBarrel, perTonne })))
      .toEqual([{ weight: 42 * 7.45, perBarrel: true, perTonne: 7.45 }, { weight: -7.45, perBarrel: false, perTonne: 7.45 }]);
    expect(parseFormulaExpression("8.45*42*RB=F - 8.45*BZ=F")?.legs.map(({ perTonne }) => perTonne)).toEqual([8.45, 8.45]);
  });

  test("leaves a series, a list or a pair to the parsers that read them", () => {
    for (const expression of ["", "HO=F", "AAPL, MSFT", "GAA/VOO", "BRK-B"]) {
      expect(parseFormulaExpression(expression)).toBeNull();
    }
  });

  test.each([
    ["HO=F*CL=F - BZ=F", "HO=F*CL=F multiplies two series. Each term is one series times numbers, such as 42*HO=F."],
    ["42*HO=F - 5", "5 is a number with no series: each term multiplies one series, such as 42*HO=F."],
    ["42*HO=F/3 - CL=F", "\"HO=F/3\" divides inside the formula. Divide the whole formula in brackets by a number or a series, as in (42*HO=F - BZ=F)/EURUSD=X; chart a ratio of two series as A / B on its own."],
    ["42*HO=F - BZ=F / EURUSD=X", "Divide the whole formula in brackets by a number or a series, as in (42*HO=F - BZ=F)/EURUSD=X."],
    ["2*(HO=F - CL=F)", "Brackets go around the whole formula only, then divide or multiply it: (2*42*RB=F + 42*HO=F - 3*CL=F)/3, (42*HO=F - BZ=F)/EURUSD=X."],
    ["(42*HO=F - CL=F", "The brackets in \"(42*HO=F - CL=F\" do not pair up."],
    ["(42*HO=F - CL=F)/0", "A formula cannot be divided by 0."],
    ["(42*HO=F - CL=F)/+", "Divide the whole formula by a number or a series, such as /3 or /EURUSD=X, not +."],
    ["(42*HO=F - BZ=F)/BZ=F", "BZ=F appears twice in the formula. Use each series once."],
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
    // A series the formula is divided by is the study's last input, drawn below the formula in a short panel of its own.
    const eur = buildCustomChartPreset("(42*HO=F - BZ=F)/EURUSD=X");
    expect(eur.studies[0]).toMatchObject({ inputSeriesIds: eur.series.map(({ id }) => id),
      parameters: { divisor: 1, weight1: 42, perBarrel1: 1, weight2: -1, power3: -1 } });
    expect(eur.series.map(({ panelId, axis }) => [panelId, axis])).toEqual([["main", "auto"], ["main", "right"], ["panel-2", "auto"]]);
    expect(eur.panels.map(({ id, height }) => [id, height])).toEqual([["main", undefined], ["formula", 0.3], ["panel-2", 0.2]]);
    expect(getSelectedPairStudies(buildCustomChartPreset("HO=F - BZ=F"))).toEqual(["spread"]);
    expect(buildCustomChartPreset("HO=F - BZ=F").studies.some(({ kind }) => kind === "formula")).toBe(false);
  });

  test("G's series search finds the catalog's crack spreads and adds one to the chart, reusing a leg it already has", () => {
    const registered = FUTURES_SERIES.map((definition) => seriesCatalogEntry({ definition, pluginId: "builtin" }));
    const search = (query: string) => buildSeriesCatalogSuggestions(query, { symbol: "AAPL" }, [], 8, registered);
    expect(search("crack").map(({ label }) => label)).toEqual([
      "3:2:1 crack spread", "Heating oil crack vs WTI", "Heating oil crack vs Brent",
    ]);
    const crack321 = search("refining margin")[0]!;
    expect(crack321).toMatchObject({
      formula: "(2*42*RB=F + 42*HO=F - 3*CL=F)/3",
      description: "(2*42*RB=F + 42*HO=F - 3*CL=F)/3 · USD/barrel · daily",
      detail: "Futures",
    });

    // On an empty chart it is the chart G opens for the formula.
    const preset = buildCustomChartPreset(crack321.formula!);
    const added = appendCatalogSuggestion(buildEmptyChartPreset(), crack321).spec;
    expect([added.series, added.studies]).toEqual([preset.series, preset.studies]);

    // Beside AAPL, a charted CL=F is reused and the chart's formula is replaced.
    const wti = search("crack")[1]!;
    const chart = appendCatalogSuggestion(appendCatalogSuggestion(buildPriceChartPreset("AAPL"), crack321).spec, wti);
    expect(chart.spec.series.map(({ source }) => source.kind === "security" ? source.instrument.symbol : "")).toEqual(["AAPL", "RB=F", "HO=F", "CL=F"]);
    const formulas = chart.spec.studies.filter(({ kind }) => kind === "formula");
    expect(formulas).toEqual([expect.objectContaining({ parameters: { divisor: 1, weight1: 42, perBarrel1: 1, weight2: -1 } })]);
    expect(formulas[0]!.inputSeriesIds).toEqual([chart.spec.series[2]!.id, chart.spec.series[3]!.id]);
    expect(chart.series).toBe(chart.spec.series[3]!);
    expect(chart.spec.studies.some(({ kind }) => kind === "volume")).toBe(true);
    // Its legs count toward the chart's twenty series.
    expect(() => appendCatalogSuggestion(buildCustomChartPreset("ABCDEFGHIJKLMNOPQRS".split("").join(", ")), wti))
      .toThrow("Charts support up to 20 base series.");
  });
});
