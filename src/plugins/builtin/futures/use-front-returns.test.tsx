import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act, useState } from "react";
import { createProviderMiss } from "../../../sources/provider-errors";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import { FUTURES_CONTRACTS } from "../../../market-data/futures-board";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import type { BoardQuoteMap } from "../shared/use-quote-board";
import { NO_FUTURES_RETURNS } from "./returns";
import { resetFrontContractReturns, useFrontContractReturns, type FrontReturnsMap } from "./use-front-returns";

const tui = createOpenTuiTestHarness();
const crude = [FUTURES_CONTRACTS.find((contract) => contract.symbol === "CL=F")!];

const lastUpdated = Date.parse("2026-09-27T22:30:00Z");
const quote = { symbol: "CL=F", name: "Crude Oil Nov 26", price: 102, change: 0, changePercent: 0, currency: "USD", lastUpdated } as Quote;
const quotes: BoardQuoteMap = new Map([["CL=F", { quote, loading: false, error: null, stale: false }]]);
const bars = (...rows: Array<[string, number]>) => rows.map(([day, close]) => ({ date: new Date(`${day}T04:00:00Z`), close }) as PricePoint);
const history = bars(["2025-12-30", 80], ["2026-08-27", 95], ["2026-09-18", 98], ["2026-09-25", 100]);

// Another test file's pane may have read this contract's history already.
beforeEach(resetFrontContractReturns);
afterEach(() => {
  setSystemTime();
  resetFrontContractReturns();
});

/** Renders the hook on the crude row, whose quote names November, so its history is the one contract CLX26.NYM. */
async function renderBoard(read: () => Promise<PricePoint[]>) {
  const handle = { returns: new Map() as FrontReturnsMap, setEnabled: (_enabled: boolean) => {} };
  const asked: string[] = [];
  const provider = { getPriceHistory: async (symbol: string) => { asked.push(symbol); return read(); } } as unknown as DataProvider;
  function Probe() {
    const [enabled, set] = useState(true);
    handle.setEnabled = set;
    handle.returns = useFrontContractReturns(crude, quotes, provider, enabled);
    return null;
  }
  await act(async () => { await tui.render(<Probe />, { width: 10, height: 3 }); });
  await act(async () => { await Bun.sleep(5); });
  const showAgain = async () => {
    await act(async () => { handle.setEnabled(false); });
    await act(async () => { handle.setEnabled(true); await Bun.sleep(5); });
  };
  return { handle, asked, showAgain };
}

test("a year's read that starts on a day that did not trade reads the weeks before it, for the close the 1Y return is measured from", async () => {
  // Sun 27 Sep 2026: a year back is Sat 27 Sep 2025, and the year's read starts on the Monday after it.
  setSystemTime(new Date("2026-09-27T23:00:00Z"));
  const asked: Array<{ start: string; end: string; barSize: string }> = [];
  const provider = {
    getPriceHistory: async () => bars(["2025-09-29", 90], ...[...history].map((point) => [point.date.toISOString().slice(0, 10), point.close] as [string, number])),
    getDetailedPriceHistoryWithMetadata: async (_symbol: string, _exchange: string, start: Date, end: Date, barSize: string) => {
      asked.push({ start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), barSize });
      return { points: bars(["2025-09-25", 84], ["2025-09-26", 85]) };
    },
  } as unknown as DataProvider;
  const handle = { returns: new Map() as FrontReturnsMap };
  function Probe() {
    handle.returns = useFrontContractReturns(crude, quotes, provider, true);
    return null;
  }
  await act(async () => { await tui.render(<Probe />, { width: 10, height: 3 }); });
  await act(async () => { await Bun.sleep(5); });
  expect(asked).toEqual([{ start: "2025-09-13", end: "2025-09-29", barSize: "1d" }]);
  expect(handle.returns.get("CL=F")!.values["1Y"]).toBeCloseTo((102 / 85 - 1) * 100, 10);
});

test("a history that failed to read is not kept as none: the row draws without returns, and is asked again once the retry delay has passed", async () => {
  let read: () => Promise<PricePoint[]> = async () => { throw new Error("Cloud chart data is unavailable"); };
  const { handle, asked, showAgain } = await renderBoard(() => read());
  expect(handle.returns.get("CL=F")).toEqual({ loading: false, values: NO_FUTURES_RETURNS });
  expect(asked).toEqual(["CLX26.NYM"]);

  read = async () => history;
  await showAgain();
  expect(asked).toHaveLength(1);
  setSystemTime(Date.now() + 61_000);
  await showAgain();
  expect(asked).toHaveLength(2);
  const values = handle.returns.get("CL=F")!;
  expect(values.loading).toBe(false);
  expect(values.values["1W"]).toBeCloseTo((102 / 98 - 1) * 100, 10);
});

test("a contract the source has no history for, empty or a miss, is an answer kept for the TTL", async () => {
  for (const answer of [async () => [] as PricePoint[], async (): Promise<PricePoint[]> => { throw createProviderMiss("No data found, symbol may be delisted"); }]) {
    resetFrontContractReturns();
    const { handle, asked, showAgain } = await renderBoard(answer);
    expect(handle.returns.get("CL=F")).toEqual({ loading: false, values: NO_FUTURES_RETURNS });
    setSystemTime(Date.now() + 10 * 60_000);
    await showAgain();
    expect(asked).toHaveLength(1);
    setSystemTime(Date.now() + 31 * 60_000);
    await showAgain();
    expect(asked).toHaveLength(2);
    setSystemTime();
  }
});

test("returns already read keep drawing while a refresh of the history fails", async () => {
  let failing = false;
  const { handle, showAgain } = await renderBoard(async () => {
    if (failing) throw new Error("Cloud chart data is unavailable");
    return history;
  });
  expect(handle.returns.get("CL=F")!.values["1M"]).toBeCloseTo((102 / 95 - 1) * 100, 10);
  failing = true;
  setSystemTime(Date.now() + 31 * 60_000);
  await showAgain();
  const kept = handle.returns.get("CL=F")!;
  expect(kept.loading).toBe(false);
  expect(kept.values["1M"]).toBeCloseTo((102 / 95 - 1) * 100, 10);
});
