import { expect, test } from "bun:test";
import { newsSummaryLine, summaryRestatesHeadline } from "./news-model";

test("a summary that says its headline again in other words is left out; one that adds the why or the numbers stays", () => {
  // Stories as a ticker's feed served them on 2026-11-06.
  expect(summaryRestatesHeadline("Apple seeks about $7 billion from bond sale, Bloomberg News reports",
    "Apple is seeking to raise about $7 billion through a bond sale, Bloomberg News reports.")).toBe(true);
  expect(summaryRestatesHeadline("EXCLUSIVE: Apple's predictive text restrictions include 'Dictator Trump' and 'Sleepy Joe,' researcher finds",
    "A researcher found that Apple's predictive text feature restricts phrases including \u201cDictator Trump\u201d and \u201cSleepy Joe.\u201d")).toBe(true);
  expect(summaryRestatesHeadline("Apple has been outperforming. But, the good times could soon end, Daiwa says",
    "Daiwa says Apple\u2019s recent outperformance may not last, raising a cautionary outlook on the stock.")).toBe(false);
  expect(newsSummaryLine({ title: "Fed holds rates steady",
    summary: "The Federal Reserve kept its benchmark rate at 3.75%-4% and signaled\n two more cuts next year." }))
    .toBe("The Federal Reserve kept its benchmark rate at 3.75%-4% and signaled two more cuts next year.");
  expect(newsSummaryLine({ title: "Apple shares jump to all-time high", summary: "Apple shares jumped to an all-time high." })).toBeNull();
});
