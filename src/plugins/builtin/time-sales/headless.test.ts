import { expect, test } from "bun:test";
import type { TapeRange } from "../../../api-client/tape";
import type { HeadlessBundleResult, HeadlessPaneContext } from "../../../types/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { timeSalesHeadless } from "./headless";
import { tapeFixture } from "./test-fixture";

async function report(symbol: string, exchange?: string) {
  const asked: string[] = [];
  const context = createTestHeadlessContext({
    settings: { tab: "quotes" },
    resolveInstrument: async () => ({ symbol, exchange }),
    apiClient: {
      getCloudTape: async (tapeSymbol: string, tapeExchange: string) => {
        asked.push(tapeSymbol);
        return { ...tapeFixture(), symbol: tapeSymbol, exchange: tapeExchange };
      },
    } as unknown as HeadlessPaneContext["apiClient"],
  });
  const result = await timeSalesHeadless.load(createTestHeadlessArgs({ argument: symbol, symbols: [symbol] }), context) as HeadlessBundleResult;
  return { result, asked };
}

test("QR on a listing abroad says where the finest bars are instead of loading an empty tape", async () => {
  // The suffix names the ASX; a saved exchange abroad reads the same.
  for (const [symbol, exchange] of [["RMS.AX", undefined], ["7203", "JPX"]] as const) {
    const { result, asked } = await report(symbol, exchange);
    expect(asked).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.sections).toEqual([{ title: "NBBO", rows: [],
      empty: `No second or tick bars; 1-minute bars: fn GIP ${symbol}; trades exist for US listings only.` }]);
  }
  // A US listing loads its tape and keeps the source's own gaps.
  const us = await report("AAPL");
  expect(us.asked).toEqual(["AAPL"]);
  expect(us.result.errors).toEqual(["Observed window only"]);
  expect(us.result.sections.map(({ title }) => title)).toEqual(["Observed window", "Regular session", "Trades", "NBBO"]);
});

/** A closed session on Fri 16 Oct 2026, served by the latest tape and, when the server reads windows, by the window asked for. */
function windowContext(readsWindows: boolean) {
  const asked: Array<TapeRange | undefined> = [];
  const stamp = (time: string) => `2026-10-16T${time}.000000001Z`;
  const trade = (time: string, price: number) => ({ ...tapeFixture().trades[0]!, id: time.replaceAll(":", ""), timestamp: stamp(time), price });
  const session = { date: "2026-10-16", high: 77.14, low: 76.8, asOf: "2026-10-16T20:00:00.000Z" };
  const latest = { ...tapeFixture(), symbol: "HYG", exchange: "NYSEARCA", session, status: "available" as const, gaps: [],
    generatedAt: "2026-10-19T10:00:00.000Z", observedFrom: stamp("14:31:00"), asOf: stamp("19:59:59"),
    trades: [trade("19:59:59", 76.9), trade("14:32:00", 76.95), trade("14:31:00", 77)], quotes: [] };
  const context = createTestHeadlessContext({
    resolveInstrument: async () => ({ symbol: "HYG", exchange: "NYSEARCA" }),
    apiClient: {
      getCloudTape: async (_symbol: string, _exchange: string, _signal?: AbortSignal, range?: TapeRange) => {
        asked.push(range);
        if (!range || !readsWindows) return latest;
        return { ...latest, observedFrom: stamp("14:30:05"), asOf: stamp("14:31:00"), window: { ...range, truncated: { trades: true, quotes: false } },
          trades: [trade("14:30:05", 77.1), trade("14:31:00", 77)] };
      },
    } as unknown as HeadlessPaneContext["apiClient"],
  });
  return { context, asked };
}

const windowArgs = (from: string, to = "") => createTestHeadlessArgs({ argument: "HYG", symbols: ["HYG"], options: { limit: 100, from, to } });
const tradeTimes = (result: HeadlessBundleResult) => result.sections.find((section) => section.title === "Trades")!.rows!.map((row) => row.timestamp);

test("--from and --to read that window of the served session, oldest first, saying what it covers and when the server cut it", async () => {
  const { context, asked } = windowContext(true);
  const result = await timeSalesHeadless.load(windowArgs("10:30", "10:35"), context) as HeadlessBundleResult;
  // The latest tape names the session; the window is asked for in instants on its date.
  expect(asked).toEqual([undefined, { from: "2026-10-16T14:30:00.000Z", to: "2026-10-16T14:35:00.000Z" }]);
  expect(result.sections[0]!.title).toBe("Window");
  expect(tradeTimes(result)).toEqual(["2026-10-16T14:30:05.000000001Z", "2026-10-16T14:31:00.000000001Z"]);
  expect(result.notes).toEqual([
    "Window: Fri 16 Oct 2026, 10:30:00 ET (14:30:00 UTC) to 10:35:00 ET (14:35:00 UTC).",
    "The window holds more than 1000 trades: these are the first, through 10:31:00 ET (14:31:00 UTC); start --from there to read on.",
  ]);
  expect(result.metadata).toMatchObject({ window: { from: "2026-10-16T14:30:00.000Z", to: "2026-10-16T14:35:00.000Z" } });

  await expect(timeSalesHeadless.load(windowArgs("03:00"), context)).rejects.toThrow(
    "--from 03:00:00 ET (07:00:00 UTC) is outside the window TAS serves: Fri 16 Oct 2026, 04:00:00 ET (08:00:00 UTC) to 20:00:00 ET (00:00:00 UTC).");
});

test("a server that serves only its latest tape gives the window's part of it, dated by those prints, and says what it leaves out", async () => {
  const { context } = windowContext(false);
  const result = await timeSalesHeadless.load(windowArgs("10:30", "10:35"), context) as HeadlessBundleResult;
  expect(tradeTimes(result)).toEqual(["2026-10-16T14:31:00.000000001Z", "2026-10-16T14:32:00.000000001Z"]);
  expect(result.notes).toContain("This server serves only its latest tape, from 10:31:00 ET (14:31:00 UTC): prints before it are not listed.");
  expect(result.metadata).toMatchObject({ asOf: "2026-10-16T14:32:00.000000001Z", observedFrom: "2026-10-16T14:31:00.000000001Z" });
});
