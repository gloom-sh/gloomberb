import { expect, test } from "bun:test";
import { GC_CURVE_WORDS, questionMarkets, ratesQuestionFunctions } from "./rates-question";
import { isCurveId, parseCurveArgument } from "../../plugins/builtin/yield-curve/curves";

const run = (question: string) => ratesQuestionFunctions(question).map(({ code, argument }) => `${code}${argument ? ` ${argument}` : ""}`);

// Asked signed out, "BoJ and RBA policy rates and JGB yields" was offered CBR, then MDAY and FIRST.
test("a rates or curve question is CBR, GC and ECO, the ones it asks about first, run for the markets it names", () => {
  expect(run("What did the BoJ and RBA do with policy rates this week, and where are JGB yields?")).toEqual(["CBR", "GC jgb", "ECO JP,AU"]);
  expect(ratesQuestionFunctions("BoJ rate decision and JGBs")[1]).toEqual({ code: "GC", argument: "jgb", input: "JGB" });
  // Two curves are the world tab's; the euro area is ECO's EU.
  expect(run("Compare Bund and gilt yields")).toEqual(["GC --tab world", "CBR", "ECO DE,GB"]);
  expect(run("Will the ECB cut before the Fed?")).toEqual(["CBR", "GC --tab world", "ECO EU,US"]);
  // A calendar question alone is ECO's, for the catalog to add to.
  expect(run("When is the next US CPI release?")).toEqual(["ECO US"]);
  // A stock's yield, a question with no rates in it, and "us" that is no country are none of these.
  expect(run("What are the highest dividend yields in the S&P 500?")).toEqual([]);
  expect(run("what did the DAX do yesterday?")).toEqual([]);
  // A cut with no market or bank named is a company's, and a week alone is no calendar's.
  expect(run("Did UAL raise or cut its guidance?")).toEqual([]);
  expect(run("Why did airline stocks fall this week?")).toEqual([]);
  expect(questionMarkets("tell us about the RBA and the Reserve Bank of New Zealand")).toEqual(["AU", "NZ"]);
});

test("each market's curve word opens GC on that market's curve", () => {
  for (const [market, word] of Object.entries(GC_CURVE_WORDS)) {
    const { curve } = parseCurveArgument(word);
    expect(curve, market).not.toBeNull();
    expect(isCurveId(curve)).toBe(true);
    expect(curve === "eu-aaa" ? "EA" : curve?.toUpperCase(), word).toBe(market);
  }
});
