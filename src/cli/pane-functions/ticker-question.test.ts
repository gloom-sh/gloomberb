import { expect, test } from "bun:test";
import { questionTickers, questionWindow, tickerQuestion } from "./ticker-question";

const NOW = new Date("2026-11-21T03:00:00Z");

test("a question's tickers are its cashtags and its symbols in capitals, never an abbreviation, a function's code or a shout", async () => {
  expect(await questionTickers("What moved DAL UAL and AAL from November 9 to November 13, 2026?")).toEqual(["DAL", "UAL", "AAL"]);
  // AI is C3.ai's ticker and the AI trade; US, CEO, P/E, S&P, U.S. and Q4 are no company.
  expect(await questionTickers("Did the US CEO talk about AI, P/E, the S&P, U.S. demand or Q4?")).toEqual([]);
  expect(await questionTickers("What is MSFT's P/E, and where is $dal?")).toEqual(["MSFT", "DAL"]);
  // Only the large caps ship: a symbol they do not carry still counts from three letters, a function's code does not.
  expect(await questionTickers("What does OMON show for LUV?", new Set(["OMON"]))).toEqual(["LUV"]);
  expect(await questionTickers("WHAT MOVED DAL TODAY")).toEqual([]);
});

test("the dates a question names are a window, a year stated once counting for both", () => {
  expect(questionWindow("from November 9 to November 13, 2026", NOW)).toEqual({ from: "2026-11-09", to: "2026-11-13" });
  expect(questionWindow("between 13 Nov and 9 Nov", NOW)).toEqual({ from: "2026-11-09", to: "2026-11-13" });
  expect(questionWindow("since 2026-11-02", NOW)).toEqual({ from: "2026-11-02" });
  expect(questionWindow("How did $DAL trade after its earnings on October 9?", NOW)).toEqual({ from: "2026-10-09" });
  expect(questionWindow("What happened on Oct 9?", NOW)).toEqual({ from: "2026-10-09", to: "2026-10-09" });
  // A day this year has not reached yet is last year's; one that does not exist is no window.
  expect(questionWindow("What happened on December 24?", NOW)).toEqual({ from: "2025-12-24", to: "2025-12-24" });
  expect(questionWindow("What happened on November 31?", NOW)).toBeNull();
});

test("a move asked about is the prices over those days, then the first ticker's news and analysts", async () => {
  const run = async (question: string) => (await tickerQuestion(question, { now: NOW }))?.functions.map(({ code, argument }) => `${code} ${argument}`);
  expect(await run("What moved DAL UAL and AAL from November 9 to November 13, 2026?"))
    .toEqual(["CMP DAL,UAL,AAL --from 2026-11-09 --to 2026-11-13", "CN DAL", "ANR DAL"]);
  expect(await run("What moved AAPL today?")).toEqual(["QQ AAPL", "CN AAPL", "ANR AAPL"]);
  expect(await run("How did DAL do in 2025?")).toEqual(["HP DAL --from 2025-01-01 --to 2025-12-31", "CN DAL", "ANR DAL"]);
  expect(await run("Compare DAL and UAL year to date")).toEqual(["CMP DAL,UAL --range-preset YTD", "CN DAL", "ANR DAL"]);
  // A price target is the analysts', not a move; guidance and holders are their own functions.
  expect(await run("What is the price target for AAL?")).toEqual(["ANR AAL"]);
  expect(await run("Did UAL raise or cut its guidance?")).toEqual(["GUIDE UAL"]);
  expect(await run("Who holds the most AAL stock?")).toEqual(["HDS AAL"]);
  expect(await run("What did the DAX do yesterday?")).toBeUndefined();
});
