import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { CorporateActionsData, SplitHistory } from "../../../types/financials";
import { corporateSplitFactor, corporateSplitLookup, loadSplitFactors } from "./data";
import type { FundDetailData, ThirteenFFormSummary, ThirteenFHoldingRecord } from "./types";

afterEach(() => { setSystemTime(); });

const form = (period: string): ThirteenFFormSummary => ({ url: "", accessionNumber: period, submissionType: "13F-HR", periodOfReport: period, filedAsOfDate: period, cik: "1", companyName: "Fund", tableValueTotal: 1, tableEntryTotal: 1, isAmendment: false });
const row = (ticker: string, cusip: string, value: number, shares: number): ThirteenFHoldingRecord => ({ accessionNumber: "", cik: "1", issuer: ticker, titleOfClass: "COM", cusip, ticker, value, shares, shareType: "SH", investmentDiscretion: "", votingAuthoritySole: 0, votingAuthorityShared: 0, votingAuthorityNone: 0, putCall: "" });

/** A large filer whose `count` lines each went 10:1 in shares on paper, T0 held under a second CUSIP as well. */
function largeFiler(count: number): { detail: FundDetailData; tickers: string[] } {
  const tickers = Array.from({ length: count }, (_, index) => `T${index}`);
  const lines = [...tickers, "T0"];
  return {
    tickers,
    detail: {
      cik: "1", name: "Fund", forms: [], latestForm: form("2026-06-30"), previousForm: form("2026-03-31"),
      latestHoldings: lines.map((ticker, index) => row(ticker, `C${index}`, 1200 + index, 100)),
      previousHoldings: lines.map((ticker, index) => row(ticker, `C${index}`, 1000 + index, 10)),
    },
  };
}

/** Even tickers went 10:1 in May; odd ones did not split. */
const splitsOf = (ticker: string) => Number(ticker.slice(1)) % 2 === 0 ? [{ date: "2026-05-04", fromFactor: 1, toFactor: 10 }] : [];
const history = (symbol: string): SplitHistory => ({ symbol, splits: splitsOf(symbol), coverage: "available" });
const actions = (symbol: string): CorporateActionsData => ({ symbol, dividends: [], earnings: [], splits: splitsOf(symbol), coverage: { splits: "available" } });

test("a large filer's split checks read each ticker once, in batches of 25, and a reopen reads nothing; the factors are its corporate actions'", async () => {
  const { detail, tickers } = largeFiler(300);
  const batches: string[][] = [];
  const single: string[] = [];
  const source = {
    // T5 is one the service could not answer in its batch.
    getSplitHistoryBatch: async (symbols: string[]) => {
      batches.push(symbols);
      return new Map(symbols.filter((symbol) => symbol !== "T5").map((symbol) => [symbol, history(symbol)] as const));
    },
    getCorporateActions: async (ticker: string) => {
      single.push(ticker);
      return actions(ticker);
    },
  };
  const first = await loadSplitFactors(detail, corporateSplitLookup(source));
  expect(batches.flat().toSorted()).toEqual(tickers.toSorted());
  expect(batches.map((batch) => batch.length)).toEqual(Array(12).fill(25));
  // The largest lines are asked first: T0's second line, then T299.
  expect(batches[0]!.slice(0, 3)).toEqual(["T0", "T299", "T298"]);
  expect(single).toEqual(["T5"]);
  expect([first.get("C0||SH"), first.get("C1||SH"), first.get("C300||SH"), first.get("C5||SH")]).toEqual([10, 1, 10, 1]);

  // Reopened, refreshed, or another fund holding the same tickers: answered from the session.
  const again = await loadSplitFactors(detail, corporateSplitLookup(source));
  expect([batches.length, single.length]).toEqual([12, 1]);
  expect(Object.fromEntries(again)).toEqual(Object.fromEntries(first));

  // The same factors as each ticker's corporate actions read one at a time.
  const perTicker = { getCorporateActions: async (ticker: string) => actions(ticker) };
  const unbatched = await loadSplitFactors(detail, (ticker, after, through) => corporateSplitFactor(perTicker, ticker, after, through));
  expect(Object.fromEntries(first)).toEqual(Object.fromEntries(unbatched));
});

test("a service without the batch is read a ticker at a time, six at once, each once; a failed read is asked again after a minute", async () => {
  const { detail, tickers } = largeFiler(40);
  const asked: string[] = [];
  let running = 0;
  let most = 0;
  let down = true;
  const source = {
    getSplitHistoryBatch: async () => null,
    getCorporateActions: async (ticker: string) => {
      asked.push(ticker);
      most = Math.max(most, ++running);
      await Bun.sleep(1);
      running -= 1;
      if (ticker === "T8" && down) throw new Error("corporate actions down");
      return actions(ticker);
    },
  };
  const first = await loadSplitFactors(detail, corporateSplitLookup(source));
  expect(asked.toSorted()).toEqual(tickers.toSorted());
  expect(most).toBeLessThanOrEqual(6);
  expect([first.get("C8||SH"), first.get("C2||SH")]).toEqual([null, 10]);

  down = false;
  await loadSplitFactors(detail, corporateSplitLookup(source));
  expect(asked).toHaveLength(40);
  setSystemTime(new Date(Date.now() + 61_000));
  const later = await loadSplitFactors(detail, corporateSplitLookup(source));
  expect(asked.slice(40)).toEqual(["T8"]);
  expect(later.get("C8||SH")).toBe(10);
});
