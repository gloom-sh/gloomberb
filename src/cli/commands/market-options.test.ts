import { afterEach, beforeEach, expect, setSystemTime, spyOn, test, type Mock } from "bun:test";
import { apiClient } from "../../api-client";
import { marketDataCliCommands } from "./market";
import { createTestCliContext } from "../../test-support/cli-context";
import { serializeCliResult } from "../result";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { EXPORT_IDENTITY_COLUMNS } from "../export-source";

const options = marketDataCliCommands.find((command) => command.name === "options")!;

// The open-interest date comes from OPX's listing; no test reaches the network for it.
let listedOpenInterest: Mock<typeof apiClient.optionsPositioning>;
beforeEach(() => { listedOpenInterest = spyOn(apiClient, "optionsPositioning").mockRejectedValue(new Error("offline")); });
afterEach(() => listedOpenInterest.mockRestore());

async function warningsFor(chain: object, stored: number, refreshError: unknown): Promise<string[] | undefined> {
  const cli = createTestCliContext({
    dataProvider: { getCachedQuery: () => ({ load: async () => ({
      value: chain, fetchedAt: stored, staleAt: stored, expiresAt: Infinity, source: "cloud", refreshError,
    }) }) },
  }, { refresh: true });
  await options.execute(["AAPL"], cli.context);
  return cli.printed[0]!.result.warnings;
}

test("options reports when a failed refresh falls back to a stored chain", async () => {
  const stored = Date.parse("2026-09-22T19:55:00Z");
  const chain = { underlyingSymbol: "AAPL", expirationDates: [1], calls: [], puts: [] };
  const warnings = await warningsFor(chain, stored, new Error("429"));
  expect(warnings).toHaveLength(1);
  expect(warnings![0]).toContain("2026-09-22T19:55:00.000Z");
});

test("options flags a chain last observed before today's US open", async () => {
  // 09:45 New York: the delayed chain may still be yesterday's closing snapshot.
  setSystemTime(new Date("2026-09-23T13:45:00Z"));
  try {
    const warnings = [];
    for (const asOf of ["2026-09-22T19:59:59Z", "2026-09-23T13:31:00Z"]) {
      const chain = { underlyingSymbol: "AAPL", expirationDates: [1], calls: [], puts: [], asOf };
      warnings.push(await warningsFor(chain, Date.now(), undefined));
    }
    expect(warnings[0]).toEqual(["No option trades this session yet (last trade 2026-09-22T19:59:59Z)"]);
    expect(warnings[1]).toBeUndefined();
  } finally {
    setSystemTime();
  }
});

const EXPIRIES = ["2027-12-17", "2028-03-17", "2028-06-16"].map((date) => Date.parse(`${date}T00:00:00Z`) / 1000);

function expiryProvider(contractExpiries: number[]) {
  const requests: unknown[][] = [];
  const contract = (expiration: number) => ({
    contractSymbol: "AAPL", strike: 100, currency: "USD", lastPrice: 1, change: 0, percentChange: 0, bid: 1, ask: 2,
    impliedVolatility: 0, inTheMoney: false, expiration, lastTradeDate: 0,
  });
  const dataProvider = {
    getOptionsChain: async (...args: unknown[]) => {
      requests.push(args);
      return { underlyingSymbol: "AAPL", expirationDates: EXPIRIES, calls: contractExpiries.map(contract), puts: [] };
    },
  };
  return { requests, cli: createTestCliContext({ dataProvider }) };
}

test("options takes --expiration as a date, asks for its UTC midnight, and rejects what it cannot read before asking", async () => {
  const hit = expiryProvider([EXPIRIES[1]!]);
  await options.execute(["AAPL", "--expiration", "2028-03-17"], hit.cli.context);
  expect(hit.requests[0]!.slice(0, 3)).toEqual(["AAPL", "", EXPIRIES[1]]);
  expect(hit.cli.printed[0]!.options!.rows!(hit.cli.printed[0]!.result.data)).toHaveLength(1);

  for (const bad of ["2028-02-30", "next-friday", "17-3-2028"]) {
    const miss = expiryProvider([]);
    await expect(options.execute(["AAPL", "--expiration", bad], miss.cli.context)).rejects.toThrow(`Invalid --expiration "${bad}"`);
    expect(miss.requests).toEqual([]);
  }
  await expect(options.execute(["AAPL", "--expiration"], expiryProvider([]).cli.context)).rejects.toThrow("--expiration needs a date");
});

test("options fails on an expiry the chain does not list, in dates, and on one the provider answered with other contracts", async () => {
  const unlisted = expiryProvider([]);
  await expect(options.execute(["AAPL", "--expiration", "2028-01-21"], unlisted.cli.context))
    .rejects.toThrow("no expiry 2028-01-21 for AAPL; available: 2027-12-17, 2028-03-17, 2028-06-16");
  expect(unlisted.cli.printed).toEqual([]);
  // Unix seconds read the same way, rendered as the date they fall on.
  await expect(options.execute(["AAPL", "--expiration", "1832025600"], expiryProvider([]).cli.context))
    .rejects.toThrow("no expiry 2028-01-21 for AAPL");
  // A provider that hands back its nearest expiry for an unlisted date has not answered the request.
  await expect(options.execute(["AAPL", "--expiration", "2028-01-21"], expiryProvider([EXPIRIES[0]!]).cli.context))
    .rejects.toThrow("no expiry 2028-01-21 for AAPL");
});

test("after Friday's close options shows the nearest live expiry, not the one the source still defaults to, and names it for a lapsed date", async () => {
  // Saturday morning: the source still answers a chain without a date with Friday's, and lists it.
  setSystemTime(new Date("2026-10-24T05:24:00Z"));
  try {
    const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
    const friday = day("2026-10-23"), next = day("2026-10-30"), later = day("2026-11-06");
    const requests: unknown[] = [];
    const dataProvider = {
      getOptionsChain: async (_symbol: string, _exchange: string, expiration?: number) => {
        requests.push(expiration);
        return { underlyingSymbol: "COPX", expirationDates: [friday, next, later], puts: [], calls: [{ contractSymbol: "COPX", strike: 45,
          currency: "USD", lastPrice: 1, change: 0, percentChange: 0, bid: 1, ask: 2, impliedVolatility: 0, inTheMoney: false,
          expiration: expiration ?? friday, lastTradeDate: 0 }] };
      },
    };
    const shown = createTestCliContext({ dataProvider });
    await options.execute(["COPX"], shown.context);
    expect(requests).toEqual([undefined, next]);
    const printed = shown.cli ? undefined : shown.printed[0]!;
    expect(printed!.options!.rows!(printed!.result.data).map((row) => row.expiration)).toEqual(["2026-10-30"]);
    expect(printed!.result.metadata!.expirations).toEqual([next, later]);

    await expect(options.execute(["COPX", "--expiration", "2026-10-23"], createTestCliContext({ dataProvider }).context))
      .rejects.toThrow("expiry 2026-10-23 for COPX expired on 23 Oct; nearest live: 30 Oct (--expiration 2026-10-30)");
  } finally {
    setSystemTime();
  }
});

test("an options export says on every row what it is, the spot and time behind IV and delta, and the open interest's date", async () => {
  const expiration = EXPIRIES[1]!;
  const closeAt = Date.parse("2026-10-12T19:59:59Z");
  const contract = (side: "C" | "P", strike: number, bid: number, openInterest: number) => ({
    contractSymbol: `GOOGL280317${side}${String(strike * 1000).padStart(8, "0")}`, strike, currency: "USD", lastPrice: bid,
    change: 0, percentChange: 0, bid, ask: bid + 0.2, impliedVolatility: 0, inTheMoney: false, expiration, lastTradeDate: closeAt / 1000,
    volume: 1, openInterest,
  });
  const chain = { underlyingSymbol: "GOOGL", expirationDates: EXPIRIES, asOf: new Date(closeAt).toISOString(), dataSource: "delayed",
    delayMinutes: 15, calls: [contract("C", 350, 60, 120), contract("C", 360, 54, 80)], puts: [contract("P", 350, 50, 95), contract("P", 360, 56, 40)] };
  const quote = { symbol: "GOOGL", price: 354.5, currency: "USD", change: 1.8, changePercent: 0.5, lastUpdated: Date.parse("2026-10-13T12:28:00Z"),
    marketState: "PRE", extendedSessionPrint: true, regularClose: 352.72, regularCloseSessionDate: "2026-10-12" };
  listedOpenInterest.mockResolvedValue({ oiDate: "2026-10-09", expiry: "2028-03-17", strikes: [
    { strike: 350, callOI: 120, putOI: 95 }, { strike: 360, callOI: 80, putOI: 40 }] } as never);
  setSystemTime(new Date("2026-10-13T12:41:00Z"));
  try {
    const cli = createTestCliContext({ dataProvider: { getOptionsChain: async () => chain, getQuote: async () => quote,
      getTickerFinancials: async () => ({ quote, fundamentals: { dividendYield: 0 }, annualStatements: [], quarterlyStatements: [], priceHistory: [] }) } });
    await options.execute(["GOOGL", "--expiration", "2028-03-17"], cli.context);
    const { result, options: render } = cli.printed[0]!;
    expect(listedOpenInterest).toHaveBeenCalledWith("open-interest?symbol=GOOGL&expiry=2028-03-17", expect.anything());
    const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, render).split("\n");
    const [header, ...rows] = csv.filter((line) => line && !line.startsWith("#"));
    expect(header).toBe(["Side,Contract,Expiry,Strike,Last,Bid,Ask,IV (annualized decimal),Delta (decimal),Vol,OI",
      "Spot,Spot basis,Spot as of,OI as of", ...EXPORT_IDENTITY_COLUMNS].join(","));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.split(",").slice(-9)).toEqual(["352.72", "close", "2026-10-12T20:00:00.000Z", "2026-10-09",
        "GOOGL", "USD", "snapshot", "Gloom Cloud", "2026-10-12T19:59:59.000Z"]);
    }
    // JSON carries the same.
    const json = JSON.parse(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, render));
    expect(json.metadata).toMatchObject({ symbol: "GOOGL", currency: "USD", interval: "snapshot",
      model: { spot: 352.72, spotBasis: "close", spotAsOf: "2026-10-12T20:00:00.000Z" }, openInterest: { asOf: "2026-10-09" } });
    expect(json.source).toMatchObject({ name: "Gloom Cloud", observationDate: "2026-10-12T19:59:59.000Z" });
    expect(render!.footnote).toBe("Greeks at spot 352.72 (close Mon 12 Oct), dividend yield 0%, rate 4% · OI as of Fri 9 Oct");
  } finally {
    setSystemTime();
  }
});

test("a chain that dates its own open interest is labelled with that date, and OPX is not asked", async () => {
  const put = { contractSymbol: "GOOGL280317P00350000", strike: 350, currency: "USD", lastPrice: 50, change: 0, percentChange: 0,
    bid: 50, ask: 50.2, impliedVolatility: 0, inTheMoney: false, expiration: EXPIRIES[1]!, lastTradeDate: 0, volume: 1, openInterest: 4815 };
  // A server with no date for the counts says so with null; the label then never borrows OPX's.
  for (const [openInterestAsOf, footnote] of [["2026-10-09", "OI as of Fri 9 Oct"], [null, "OI date not published"]] as const) {
    const chain = { underlyingSymbol: "GOOGL", expirationDates: EXPIRIES, calls: [], puts: [put], openInterestAsOf };
    const cli = createTestCliContext({ dataProvider: { getOptionsChain: async () => chain } });
    await options.execute(["GOOGL", "--expiration", "2028-03-17"], cli.context);
    const { result, options: render } = cli.printed[0]!;
    expect(render!.footnote).toBe(footnote);
    const json = JSON.parse(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, render));
    expect(json.metadata.openInterest).toEqual({ asOf: openInterestAsOf, listedAsOf: null, compared: 0, matched: 0 });
  }
  expect(listedOpenInterest).not.toHaveBeenCalled();
});

test("options on a company's name read as an index asks about the company's stock, whose options are listed", async () => {
  // The service answers "JP Morgan" with an index and a fund carrying the words, "JPMorgan" with the company.
  const row = (symbol: string, name: string, exchange: string, type: string) => ({ providerId: "test", symbol, name, exchange, type, currency: "USD" });
  const dataProvider = {
    search: async (query: string) => query === "JP Morgan"
      ? [row("^JTEK", "JP MORGAN ETF TRUS", "NASDAQ", "INDEX"), row("XEMD", "BondBloxx JP Morgan USD Emerging Markets 1-10 Year Bond ETF", "BATS", "ETF")]
      : query === "JPMorgan" ? [row("JPM", "JPMorgan Chase & Co.", "NYSE", "EQUITY")] : [],
    getOptionsChain: async (symbol: string) => { throw new Error(`No options provider available for ${symbol}`); },
  };
  const cli = createTestCliContext({ dataProvider });
  await expect(options.execute(["JP Morgan"], cli.context))
    .rejects.toThrow("Options are not available for ^JTEK:NASDAQ. Did you mean JPM (JPMorgan Chase & Co.)?");
});
