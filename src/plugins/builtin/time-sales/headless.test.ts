import { expect, test } from "bun:test";
import type { TapeRange } from "../../../api-client/tape";
import type { HeadlessBundleResult, HeadlessPaneContext } from "../../../types/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { timeSalesHeadless } from "./headless";
import { inTapeRange } from "./window";
import { tapeFixture } from "./test-fixture";
import { headlessReportTables } from "../../../cli/pane-functions/headless";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { renderReportCsv } from "../../../cli/report-tables";
import { portableCsv } from "../../../cli/csv-export";

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
    const args = createTestHeadlessArgs({ argument: symbol, symbols: [symbol] });
    expect(typeof timeSalesHeadless.describe === "function" && timeSalesHeadless.describe(args, result)).toBe(`Quote recap ${symbol}`);
  }
  // A US listing loads its tape and keeps the source's own gaps.
  const us = await report("AAPL");
  expect(us.asked).toEqual(["AAPL"]);
  expect(us.result.errors).toEqual(["Observed window only"]);
  // QR leads with the NBBO under its own heading; TAS with the trades, the quotes last.
  expect(us.result.sections.map(({ title }) => title)).toEqual(["NBBO", "Observed window", "Regular session", "Trades"]);
  const args = createTestHeadlessArgs({ argument: "AAPL", symbols: ["AAPL"] });
  expect(typeof timeSalesHeadless.describe === "function" && timeSalesHeadless.describe(args, us.result)).toBe("Quote recap AAPL");
  const tas = await timeSalesHeadless.load(args, createTestHeadlessContext({
    resolveInstrument: async () => ({ symbol: "AAPL" }),
    apiClient: { getCloudTape: async () => ({ ...tapeFixture(), symbol: "AAPL", exchange: "" }) } as unknown as HeadlessPaneContext["apiClient"],
  })) as HeadlessBundleResult;
  expect(tas.sections.map(({ title }) => title)).toEqual(["Observed window", "Regular session", "Trades", "NBBO"]);
  expect(typeof timeSalesHeadless.describe === "function" && timeSalesHeadless.describe(args, tas)).toBe("Time and sales AAPL");
  // Each low says what it is taken over.
  expect(tas.notes?.at(-1)).toStartWith("Observed window low and high: every print listed, odd lots included. Regular session low and high:");
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

test("TAS exports keep default truncation, the last session and explicit window caveats", async () => {
  const snapshot = tapeFixture();
  const friday = "2026-11-13T20:59:59.000Z";
  const data = { ...snapshot, generatedAt: "2026-11-15T19:00:00Z", asOf: friday, observedFrom: friday,
    session: { date: "2026-11-13", high: 102, low: 100, asOf: "2026-11-13T21:00:00Z" },
    trades: Array.from({ length: 123 }, (_, index) => ({ ...snapshot.trades[0]!, id: String(index), timestamp: friday })) };
  const args = createTestHeadlessArgs({ argument: "AAPL", symbols: ["AAPL"] });
  const result = await timeSalesHeadless.load(args, createTestHeadlessContext({
    resolveInstrument: async () => ({ symbol: "AAPL", exchange: "NASDAQ" }),
    apiClient: { getCloudTape: async () => data } as unknown as HeadlessPaneContext["apiClient"],
  })) as HeadlessBundleResult;
  const exported = (report: HeadlessBundleResult, options = args) => portableCsv(renderReportCsv(headlessReportTables(timeSalesHeadless, report, options, "TAS", deriveHeadlessFreshness(timeSalesHeadless, report), { complete: true, unavailableSymbols: [] })));
  expect(exported(result)).toContain("Listing the first 100 of 123 observed trades");
  expect(exported(result)).toContain("Market closed; last session Fri 13 Nov 2026.");
  const options = windowArgs("10:30", "10:31");
  const window = await timeSalesHeadless.load(options, windowContext(true).context) as HeadlessBundleResult;
  expect(exported(window, options)).toContain("Window: Fri 16 Oct 2026");
});

test("--from and --to read that window of the served session, oldest first, saying what it covers and when the server cut it", async () => {
  const { context, asked } = windowContext(true);
  const result = await timeSalesHeadless.load(windowArgs("10:30", "10:35"), context) as HeadlessBundleResult;
  // The latest tape names the session; the window is asked for in instants on its date.
  expect(asked).toEqual([undefined, { from: "2026-10-16T14:30:00.000Z", to: "2026-10-16T14:35:00.000Z" }]);
  expect(result.sections[0]!.title).toBe("Window");
  // A full page ends before its last stamp, whose prints the next page lists whole.
  expect(tradeTimes(result)).toEqual(["2026-10-16T14:30:05.000000001Z"]);
  expect(result.notes?.slice(0, -1)).toEqual([
    "Window: Fri 16 Oct 2026, 10:30:00 ET (14:30:00 UTC) to 10:35:00 ET (14:35:00 UTC).",
    "The window holds more than 1000 trades: these are the first 1, through 10:30:05.000000001 ET (14:30:05.000000001 UTC). "
      + "Read on from the next: fn TAS HYG --from 2026-10-16T14:31:00.000000001Z --to 10:35",
  ]);
  expect(result.notes?.at(-1)).toStartWith("Window low and high: every print listed");
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

test("reading on from each page's next start lists every print of a busy second once, trades for TAS and quotes for QR", async () => {
  // Fri 20 Nov 2026 at 15:55:00 New York: more prints in its first half second than a page holds, two sharing each boundary stamp.
  const at = (ns: string) => `2026-11-20T20:55:00.${ns}Z`;
  const stamps = ["003000000", "003000000", "006000000", "006000000", "392451122", "392451123", "392451123", "392600000", "500000000"].map(at);
  const trades = stamps.map((timestamp, index) => ({ ...tapeFixture().trades[0]!, id: String(index + 1), timestamp }));
  const quotes = stamps.map((timestamp, index) => ({ ...tapeFixture().quotes[0]!, timestamp, bidSize: index + 1 }));
  const latest = { ...tapeFixture(), symbol: "SPY", exchange: "ARCA", status: "available" as const, gaps: [],
    session: { date: "2026-11-20", high: 718.29, low: 686.75, asOf: "2026-11-20T21:00:00.000Z" }, generatedAt: "2026-11-21T01:15:00.000Z",
    capacity: { trades: 3, quotes: 3 }, trades: trades.slice(-1), quotes: quotes.slice(-1) };
  const asked: TapeRange[] = [];
  const context = createTestHeadlessContext({
    resolveInstrument: async () => ({ symbol: "SPY", exchange: "NYSEARCA" }),
    apiClient: {
      getCloudTape: async (_symbol: string, _exchange: string, _signal?: AbortSignal, range?: TapeRange) => {
        if (!range) return latest;
        asked.push(range);
        // The server: the window's first prints from its start, to the nanosecond, a page of each at most.
        const page = <T extends { timestamp: string }>(rows: T[]) => rows.filter((row) => inTapeRange(row.timestamp, range));
        const [inTrades, inQuotes] = [page(trades), page(quotes)];
        return { ...latest, window: { ...range, truncated: { trades: inTrades.length > 3, quotes: inQuotes.length > 3 } },
          trades: inTrades.slice(0, 3), quotes: inQuotes.slice(0, 3) };
      },
    } as unknown as HeadlessPaneContext["apiClient"],
  });
  for (const [view, section] of [["trades", "Trades"], ["quotes", "NBBO"]] as const) {
    const listed: string[] = [];
    let from = "15:55";
    for (let read = 0; read < 10 && from; read += 1) {
      const args = createTestHeadlessArgs({ argument: "SPY", symbols: ["SPY"], options: { limit: 1000, from, to: "15:57", ...(view === "quotes" ? { tab: "quotes" } : {}) } });
      const result = await timeSalesHeadless.load(args, context) as HeadlessBundleResult;
      const rows = result.sections.find((entry) => entry.title === section)!.rows!;
      listed.push(...rows.map((row) => `${row.timestamp}#${view === "trades" ? row.id : row.bidSize}`));
      const next = result.notes?.find((note) => note.includes("Read on from the next"));
      if (next) expect(next, view).toContain(view === "quotes" ? "fn QR SPY" : "fn TAS SPY");
      from = next ? /--from (\S+)/.exec(next)![1]! : "";
    }
    // Every print once, in order: none repeated from the page before, none skipped at a boundary.
    expect(listed, view).toEqual(stamps.map((timestamp, index) => `${timestamp}#${index + 1}`));
  }
  // A server from before exact windows reads from the start of the second: no print repeats, and the prints its page
  // cannot reach are named, with the next second to read on from.
  const floored = createTestHeadlessContext({
    resolveInstrument: async () => ({ symbol: "SPY", exchange: "NYSEARCA" }),
    apiClient: {
      getCloudTape: async (_symbol: string, _exchange: string, _signal?: AbortSignal, range?: TapeRange) => {
        if (!range) return latest;
        const window = { from: `${range.from.slice(0, 19)}.000Z`, to: range.to };
        const page = <T extends { timestamp: string }>(rows: T[]) => rows.filter((row) => inTapeRange(row.timestamp, window));
        const [inTrades, inQuotes] = [page(trades), page(quotes)];
        return { ...latest, window: { ...window, truncated: { trades: inTrades.length > 3, quotes: inQuotes.length > 3 } },
          trades: inTrades.slice(0, 3), quotes: inQuotes.slice(0, 3) };
      },
    } as unknown as HeadlessPaneContext["apiClient"],
  });
  const read = async (from: string) => await timeSalesHeadless.load(createTestHeadlessArgs({ argument: "SPY", symbols: ["SPY"],
    options: { limit: 1000, from, to: "15:57" } }), floored) as HeadlessBundleResult;
  const second = await read(at("006000000"));
  expect(second.sections.find((entry) => entry.title === "Trades")!.rows!.map((row) => row.id)).toEqual(["3"]);
  expect(second.notes).toContain("The window holds more than 3 trades: these are the first 1, through 15:55:00.006000000 ET (20:55:00.006000000 UTC). "
    + "Any trades after these and before 15:55:01 ET (20:55:01 UTC) cannot be read from it, as it reads a window from the start of its second. "
    + "Read on from that second: fn TAS SPY --from 2026-11-20T20:55:01Z --to 15:57");
  const beyond = await read(at("392451123"));
  expect(beyond.sections.find((entry) => entry.title === "Trades")!.rows).toEqual([]);
  expect(beyond.notes!.find((note) => note.startsWith("This server's page of 3 trades"))).toBe("This server's page of 3 trades ends before the window's start: "
    + "any from 15:55:00.392451123 ET (20:55:00.392451123 UTC) and before 15:55:01 ET (20:55:01 UTC) cannot be read from it, as it reads a window "
    + "from the start of its second. Read on from that second: fn TAS SPY --from 2026-11-20T20:55:01Z --to 15:57");
});
