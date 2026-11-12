import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessBundleResult, HeadlessBundleSection, HeadlessPaneEntry } from "../../../types/headless";
import type { PricePoint } from "../../../types/financials";
import { backtestHeadless } from "../backtest/headless";
import { correlationHeadless, relationshipHeadless } from "../correlation/headless";
import { kellyHeadless } from "../kelly-sizer/headless";
import { seasonalityHeadless } from "../seasonality/headless";

afterEach(() => setSystemTime());

const MONTH_CODES = "FGHJKMNQUVXZ";
const LAST_DAY = Date.UTC(2026, 9, 30);

/**
 * Two years of NG=F's weekday bars, each month on the next month's contract,
 * rolling on its first session to a contract 10% under the last one. Within a
 * contract the price rises 0.4% a session in January, March and every other
 * month, and falls 0.2% in the months between: as traded every month is a
 * loss; read within one contract half are gains. SPY closes on those
 * in-contract moves alone, so its returns are NG=F's back-adjusted ones.
 */
function series() {
  const future: PricePoint[] = [];
  const spy: PricePoint[] = [];
  let close = 3;
  let level = 100;
  let held = "";
  for (let time = Date.UTC(2024, 10, 1); time <= LAST_DAY; time += 86_400_000) {
    const date = new Date(time);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const month = date.getUTCMonth();
    const contract = `NG${MONTH_CODES[(month + 1) % 12]}${String((date.getUTCFullYear() + (month === 11 ? 1 : 0)) % 100).padStart(2, "0")}`;
    const move = month % 2 === 0 ? 1.004 : 0.998;
    const open = held && contract !== held ? close * 0.9 : close;
    close = open * move;
    level *= move;
    held = contract;
    future.push({ date, open, high: Math.max(open, close), low: Math.min(open, close), close, contract });
    spy.push({ date, open: level / move, high: level, low: level, close: level });
  }
  return { future, spy };
}

const { future, spy } = series();
const bars = (symbol: string) => symbol.startsWith("NG") ? future : spy;
const marketData = createTestDataProvider({
  getPriceHistory: async (symbol) => bars(symbol),
  getPriceHistoryWithMetadata: async (symbol) => ({ points: bars(symbol), resolution: "1d" }),
  getPriceHistoryForResolution: async (symbol) => bars(symbol),
  getPriceHistoryForResolutionWithMetadata: async (symbol) => ({ points: bars(symbol), resolution: "1d" }),
  getDetailedPriceHistory: async (symbol) => bars(symbol),
  getQuote: async () => { throw new Error("no quote"); },
});
const context = () => createTestHeadlessContext({ marketData, resolveInstrument: async (symbol) => ({ symbol, exchange: symbol.startsWith("NG") ? "NYM" : "NYSEARCA" }) });
const sections = (result: HeadlessBundleResult) => result.sections as HeadlessBundleSection[];

test("BT tests NG=F on back-adjusted bars, heads its prices so, and says why", async () => {
  setSystemTime(new Date(LAST_DAY + 2 * 86_400_000));
  const run = (equity: boolean) => backtestHeadless.load(createTestHeadlessArgs({ rawArgument: "NG=F", argument: "NG=F", symbols: ["NG=F"],
    options: { preset: "trend-200", lookback: "max", entry: "", exit: "", ...(equity ? { equity: true } : {}) } }), context()) as Promise<HeadlessBundleResult>;
  const report = await run(false);
  expect(report.notes).toContain("NG=F is a rolled front-month continuation, not one contract: rolls back-adjusted, so prices before each roll are not prices that traded.");
  const trades = sections(report).find((section) => section.title === "Trades")!;
  expect(trades.columns!.map((column) => column.header)).toEqual(["Entry", "Entry price (back-adjusted)", "Exit", "Exit price (back-adjusted)", "Return %", "Sessions"]);
  // Back-adjusted, buy and hold is the in-contract moves alone; as traded it would be well under water.
  const result = (report.metadata as { result: { benchmark: { totalReturnPct: number } } }).result;
  expect(result.benchmark.totalReturnPct).toBeGreaterThan(0);
  const curve = sections(await run(true))[0]!;
  expect(curve.textColumns!.find((column) => column.key === "close")!.header).toBe("Close (back-adjusted)");
  expect(curve.columns!.find((column) => column.key === "close")!.header).toBe("Close (back-adjusted)");
});

test("KELLY sizes NG=F on its months within one contract and says the rolls are back-adjusted", async () => {
  setSystemTime(new Date(LAST_DAY + 2 * 86_400_000));
  const report = await kellyHeadless.load(createTestHeadlessArgs({ symbols: ["NG=F"], options: { years: 1 } }), context()) as HeadlessBundleResult;
  const entries = sections(report).flatMap((section) => section.entries ?? []) as HeadlessPaneEntry[];
  const entry = (key: string) => entries.find((candidate) => candidate.key === key)!;
  expect(entry("window").formatted).toEndWith("12 monthly returns, rolls back-adjusted");
  // Six months up 8% or more, six down about 4%; as traded every one is a loss and there is nothing to size.
  expect(entry("winRate").formatted).toBe("50.0% (6 of 12 months up)");
  expect(entry("averageGain").value as number).toBeGreaterThan(0.08);
});

test("SEAS reads NG=F's months within one contract, says the rolls are back-adjusted and where its history starts", async () => {
  setSystemTime(new Date(LAST_DAY + 2 * 86_400_000));
  const report = await seasonalityHeadless.load(createTestHeadlessArgs({ symbols: ["NG=F"], options: { tab: "returns", lookbackYears: 30 } }), context()) as HeadlessBundleResult;
  expect(report.notes).toEqual(["rolls back-adjusted", "History starts 2024-11, so the 30-year lookback covers 3 calendar years"]);
  const months = sections(report)[0]!.rows!;
  expect(months.find((row) => row.month === "Jan")!.mean as number).toBeGreaterThan(0.08);
  expect(months.find((row) => row.month === "Feb")!.mean as number).toBeLessThan(-0.03);
  expect(months.find((row) => row.month === "Feb")!.mean as number).toBeGreaterThan(-0.05);
});

test("CORR and GR read NG=F's returns within one contract and say the rolls are back-adjusted", async () => {
  const args = (symbols: string[]) => ({ symbols, argument: symbols, rawArgument: symbols.join(","), options: { range: "ALL", rangePreset: "1Y", correlationWindow: 20 } });
  // SPY moves as NG=F does within a contract, so read across each roll's 10% gap the two would part.
  const matrix = await correlationHeadless.load(args(["NG=F", "SPY"]), context());
  expect(matrix.notes).toEqual(["NG=F: rolls back-adjusted"]);
  expect(matrix.rows[0]!.correlation!).toBeCloseTo(1, 9);
  const pair = await relationshipHeadless.load(args(["NG=F", "SPY"]), context());
  expect(pair.notes).toEqual(["NG=F: rolls back-adjusted"]);
  expect(pair.metadata).toMatchObject({ regression: { dependent: "NG=F", independent: "SPY" } });
  const regression = (pair.metadata as { regression: { beta: number; rSquared: number } }).regression;
  expect(regression.beta).toBeCloseTo(1, 9);
  expect(regression.rSquared).toBeCloseTo(1, 9);
});
