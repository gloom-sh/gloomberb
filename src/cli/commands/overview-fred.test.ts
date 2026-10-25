import { afterEach, expect, setSystemTime, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../api-client/request";
import { inferCliErrorOptions, printCliError } from "../errors";
import { createTestCliContext } from "../../test-support/cli-context";
import { captureConsole } from "../../test-support/console";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { overviewCliCommands } from "./overview";

const fred = overviewCliCommands.find((command) => command.name === "fred")!;

/** Gloom Cloud answering each path with a status and JSON body; every requested path is kept. */
function serve(routes: Record<string, { status: number; body: unknown }>) {
  const paths: string[] = [];
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    const route = routes[path] ?? { status: 404, body: { message: "Not found" } };
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      headers: new Headers(),
      text: async () => JSON.stringify(route.body),
    } as Response;
  });
  return paths;
}

afterEach(() => setCloudApiFetchTransport(null));

test("an unsupported series is a usage error that points at the list, whichever body the server sends", async () => {
  for (const body of [
    { code: "unsupported_series", message: "Unsupported FRED series DEXSFUS" },
    { message: "Unsupported FRED series DEXSFUS" },
  ]) {
    serve({ "/cloud/econ/series/DEXSFUS": { status: 400, body } });
    const cli = createTestCliContext();
    await expect(fred.execute(["dexsfus"], cli.context)).rejects.toThrow(
      "Unsupported FRED series DEXSFUS. List supported series with: gloom fred --list",
    );
  }
});

test("any other 400 from Gloom Cloud reaches --json as an input error, not an unexpected one", async () => {
  serve({ "/cloud/econ/series/CPIAUCSL": { status: 400, body: { message: "Use a date in YYYY-MM-DD format" } } });
  const cli = createTestCliContext();
  const error = await Promise.resolve(fred.execute(["CPIAUCSL"], cli.context)).catch((caught: unknown) => caught);
  const printed = await captureConsole(() => printCliError(error, inferCliErrorOptions(["--json"])));
  expect(JSON.parse(printed.stderr).error).toEqual({ code: "cli_error", message: "Use a date in YYYY-MM-DD format" });
});

test("fred --list filters the served series by id, title or group, and says when the server has no list yet", async () => {
  const paths = serve({
    "/cloud/econ/series": {
      status: 200,
      body: { series: [
        { id: "DEXSFUS", title: "South African Rand to U.S. Dollar Exchange Rate", group: "FX" },
        { id: "CPIAUCSL", title: "Consumer Price Index", group: "Prices" },
        { id: "DEXUSEU" },
      ] },
    },
  });
  const cli = createTestCliContext();
  await fred.execute(["--list", "fx"], cli.context);
  expect(paths).toEqual(["/cloud/econ/series"]);
  expect(cli.printed[0]!.result.data).toEqual([{ id: "DEXSFUS", title: "South African Rand to U.S. Dollar Exchange Rate", group: "FX" }]);

  serve({});
  await expect(fred.execute(["--list"], createTestCliContext().context)).rejects.toThrow("not available yet");
});

/** Gloom Cloud's FRED endpoint: each request's query is kept, and `answer` says what comes back. */
function serveSeries(answer: (query: URLSearchParams) => { observations: Array<{ date: string; value: number | null; publisher?: string; publishedAt?: string; releasedOn?: string }>; info?: Record<string, unknown> }) {
  const queries: URLSearchParams[] = [];
  setCloudApiFetchTransport(async (url) => {
    const query = new URL(url).searchParams;
    queries.push(query);
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(answer(query)) } as Response;
  });
  return queries;
}

async function runFred(args: string[]) {
  const cli = createTestCliContext();
  await fred.execute(args, cli.context);
  const { result, options } = cli.printed[0]!;
  return { result, options, text: serializeCliResult(result, DEFAULT_CLI_OPTIONS, options) };
}

const T10Y2Y_INFO = { id: "T10Y2Y", units: "Percent", frequency: "Daily", observationStart: "1976-06-01" };

test("--start takes a year or a month as the first day of it, and a series that begins later says so", async () => {
  const queries = serveSeries(() => ({ observations: [{ date: "2026-10-09", value: 0.44 }, { date: "2026-10-08", value: -0.125 }], info: T10Y2Y_INFO }));
  const year = await runFred(["T10Y2Y", "--start", "1960"]);
  expect(queries[0]!.get("startDate")).toBe("1960-01-01");
  expect(year.text).toContain("Series begins 1976-06-01.");
  expect(year.text).not.toContain("Showing from");
  await runFred(["T10Y2Y", "--start", "1999-07"]);
  expect(queries[1]!.get("startDate")).toBe("1999-07-01");
  await runFred(["T10Y2Y", "--start", "01.10.2026"]);
  expect(queries[2]!.get("startDate")).toBe("2026-10-01");
  const formats = "Use a --start date as YYYY-MM-DD, DD.MM.YYYY, Oct 14 2026, 14 October 2026, YYYY-MM or YYYY";
  for (const bad of ["1960-13", "99", "abc"]) {
    await expect(fred.execute(["T10Y2Y", "--start", bad], createTestCliContext().context)).rejects.toThrow(`${formats}, such as --start `);
  }
  await expect(fred.execute(["T10Y2Y", "--start", "13-1-1960"], createTestCliContext().context))
    .rejects.toThrow(`${formats}: type --start 1960-01-13 for 13-1-1960.`);
});

test("a start before the series begins starts every format at its first observation, and the CSV says where it begins", async () => {
  // Gloom Cloud pads DEXSFUS from 1975 with a blank row a day until it begins on 1980-01-02.
  serveSeries(() => ({
    observations: [
      { date: "1975-01-01", value: null }, { date: "1979-12-31", value: null },
      { date: "1980-01-02", value: 0.8271 }, { date: "1980-01-03", value: 0.8271 },
    ],
    info: { id: "DEXSFUS", units: "South African Rand to One U.S. Dollar", frequency: "Daily", observationStart: "1980-01-02" },
  }));
  const { result, text, options } = await runFred(["DEXSFUS", "--start", "1975", "--sort", "asc"]);
  expect(result.data).toEqual([{ date: "1980-01-02", value: 0.8271 }, { date: "1980-01-03", value: 0.8271 }]);
  expect(text.split("\n")[2]).toStartWith("1980-01-02");
  const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n");
  // A daily series is as of each row's own day; the release has nothing to say yet.
  expect(csv[0]).toBe("date,value,symbol_or_series,currency_or_unit,interval,source,as_of,period,released,retrieved");
  expect(csv[1]).toStartWith("1980-01-02,0.8271,DEXSFUS,South African Rand to One U.S. Dollar,daily,FRED,1980-01-02,1980-01-02,,");
  expect(csv.at(-1)).toBe("# note: Series begins 1980-01-02.");
});

test("a spread prints and exports in basis points as value, names bp in its unit column, and the CSV ends with FRED's publication time", async () => {
  serveSeries(() => ({
    observations: [{ date: "2026-10-09", value: 0.44 }, { date: "2026-10-08", value: -0.125 }],
    info: { ...T10Y2Y_INFO, lastUpdated: "2026-10-09 16:02:11-05", observationEnd: "2026-10-09" },
  }));
  const { result, text, options } = await runFred(["T10Y2Y"]);
  expect(text.split("\n").slice(0, 4)).toEqual(["Date        Value (bp)", "\u2500".repeat(10) + "  " + "\u2500".repeat(10), "2026-10-09          44", "2026-10-08       -12.5"]);
  expect(result.data).toEqual([{ date: "2026-10-09", value: 44 }, { date: "2026-10-08", value: -12.5 }]);
  expect(result.metadata).toMatchObject({ unit: "bp", interval: "daily" });
  const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n");
  expect(csv[0]).toBe("date,value,symbol_or_series,currency_or_unit,interval,source,as_of,period,released,retrieved");
  expect(csv[1]).toStartWith("2026-10-09,44,T10Y2Y,bp,daily,FRED,2026-10-09,2026-10-09,,");
  expect(csv[2]).toStartWith("2026-10-08,-12.5,T10Y2Y,bp,daily,FRED,2026-10-08,2026-10-08,,");
  expect(csv).toContain("# Publication time: 2026-10-09T21:02:11.000Z");
  expect(csv.at(-1)).toBe("# note: Showing from 2021-01-01; earlier: --start YYYY-MM-DD (series begins 1976-06-01).");
  // The default start says it is one.
  expect(text).toContain("Showing from 2021-01-01; earlier: --start YYYY-MM-DD (series begins 1976-06-01).");
});

test("nothing on or after --start names the latest observation, and fails a CSV rather than writing a header alone", async () => {
  const queries = serveSeries((query) => ({
    observations: query.get("startDate") ? [] : [{ date: "2026-10-09", value: 5.24 }],
    info: { id: "DGS10", units: "Percent", frequency: "Daily", observationStart: "1962-01-02" },
  }));
  const { result, text } = await runFred(["DGS10", "--start", "2026-10-11"]);
  expect(text.split("\n")[0]).toBe("Latest observation: 2026-10-09 (5.24). Nothing on or after 2026-10-11.");
  expect(queries[1]!.get("limit")).toBe("1");
  expect(result.metadata).toMatchObject({ latestObservation: { date: "2026-10-09", value: 5.24 } });
  for (const format of ["csv", "ndjson"] as const) {
    const cli = createTestCliContext(undefined, { format });
    const failed = await Promise.resolve(fred.execute(["DGS10", "--start", "2026-10-11"], cli.context)).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toBe("No DGS10 observations on or after 2026-10-11.");
    expect(cli.printed).toHaveLength(0);
  }
  // A series with no data at all, or a failed second look, keeps the plain answer.
  serveSeries(() => ({ observations: [] }));
  expect((await runFred(["DGS10", "--start", "2026-10-11"])).text.split("\n")[0]).toBe("No results.");

  // A spread exports in basis points, so the empty line names that figure, not FRED's percentage points.
  serveSeries((query) => ({
    observations: query.get("startDate") ? [] : [{ date: "2026-10-09", value: 0.44 }],
    info: T10Y2Y_INFO,
  }));
  expect((await runFred(["T10Y2Y", "--start", "2026-10-11"])).text.split("\n")[0])
    .toBe("Latest observation: 2026-10-09 (44). Nothing on or after 2026-10-11.");
});

test("a yield ahead of FRED names Treasury and when it published, in the source line and on its row; FRED's own stay FRED", async () => {
  // DGS10 on 12 Oct 2026: FRED's own data ended 8 Oct at 5.22; Treasury printed 5.24 for 9 Oct.
  const info = { id: "DGS10", units: "Percent", frequency: "Daily", source: "Board of Governors of the Federal Reserve System (US)",
    lastUpdated: "2026-10-08 15:16:37-05", observationEnd: "2026-10-08" };
  serveSeries(() => ({
    observations: [
      { date: "2026-10-09", value: 5.24, publisher: "U.S. Treasury", publishedAt: "2026-10-09T20:01:09.391Z" },
      { date: "2026-10-08", value: 5.22 },
    ],
    info,
  }));
  const ahead = await runFred(["DGS10"]);
  expect(ahead.text.split("\n").at(-1)).toBe("Source: U.S. Treasury via FRED, published 2026-10-09 \u00b7 Fri 9 Oct 2026 \u00b7 not a live feed (published statistics)");
  expect(ahead.result.data).toEqual([
    { date: "2026-10-09", value: 5.24, publisher: "U.S. Treasury", publishedAt: "2026-10-09T20:01:09.391Z", released: "2026-10-09T20:01:09.391Z" },
    { date: "2026-10-08", value: 5.22 },
  ]);
  expect(ahead.result.freshness).toMatchObject({ publisher: "U.S. Treasury", publishedAt: "2026-10-09T20:01:09.391Z" });

  // Once FRED lists it, the line is FRED's again, with FRED's own publication time.
  serveSeries(() => ({ observations: [{ date: "2026-10-09", value: 5.24 }], info: { ...info, observationEnd: "2026-10-09", lastUpdated: "2026-10-12 15:16:37-05" } }));
  const listed = await runFred(["DGS10"]);
  expect(listed.text.split("\n").at(-1)).toBe("Source: FRED \u00b7 Fri 9 Oct 2026 \u00b7 not a live feed (published statistics)");
  expect(listed.result.freshness).toMatchObject({ publisher: info.source, publishedAt: "2026-10-12T20:16:37.000Z" });
});

test("a series FRED does not carry names its publisher and where it is read from, never FRED", async () => {
  // Turkish CPI: September 2026 read as it came out, August read with the history.
  serveSeries(() => ({
    observations: [
      { date: "2026-09-01", value: 29.73, publisher: "TurkStat", publishedAt: "2026-10-05T07:05:00.000Z" },
      { date: "2026-08-01", value: 31.51, publisher: "TurkStat" },
    ],
    info: { id: "TURCPIYOY", units: "Percent change from year ago", frequency: "Monthly", observationEnd: "2026-09-01" },
  }));
  const turkey = await runFred(["TURCPIYOY"]);
  expect(turkey.text.split("\n").at(-1)).toStartWith("Source: TurkStat via the CBRT, published 2026-10-05 \u00b7 Sep 2026");
  expect(turkey.result.freshness).toMatchObject({ publisher: "TurkStat", publishedAt: "2026-10-05T07:05:00.000Z" });
});

test("a monthly series is dated by its month, and a lagging one carries its note", async () => {
  serveSeries(() => ({
    observations: [{ date: "2026-08-01", value: 51.7 }, { date: "2026-07-01", value: 55.2 }],
    info: { id: "UMCSENT", units: "Index 1966:Q1=100", frequency: "Monthly", observationStart: "1952-11-01" },
  }));
  const { result, text } = await runFred(["UMCSENT"]);
  const lines = text.split("\n");
  expect(lines.at(-1)).toBe("Source: FRED \u00b7 Aug 2026 (monthly) \u00b7 not a live feed (published statistics)");
  expect(text).toContain("FRED publishes the University of Michigan survey with a lag; latest preliminary reading: fn ECO");
  expect(result.metadata?.notes).toHaveLength(2);
  expect(result.freshness).toMatchObject({ asOf: "2026-08-01", periodicity: "monthly" });
});

test("a monthly series names its month and the day it was released, and the report is as of that release", async () => {
  setSystemTime(new Date("2026-10-23T15:00:00Z"));
  try {
    serveSeries(() => ({
      observations: [{ date: "2026-09-01", value: 1412, releasedOn: "2026-10-20" }, { date: "2026-08-01", value: 1330 }],
      info: { id: "PERMIT", units: "Thousands of Units", frequency: "Monthly", observationStart: "1960-01-01", observationEnd: "2026-09-01",
        lastUpdated: "2026-10-20 07:33:50-05", source: "U.S. Census Bureau" },
    }));
    const { result, text } = await runFred(["PERMIT"]);
    expect(text.split("\n").at(-1)).toBe("Source: FRED \u00b7 Sep 2026, released Tue 20 Oct \u00b7 not a live feed (published statistics)");
    expect(result.freshness).toMatchObject({ asOf: "2026-10-20", referencePeriod: "2026-09-01", periodicity: "monthly", publisher: "U.S. Census Bureau" });
  } finally {
    setSystemTime();
  }
});

test("a quarterly flow at a seasonally adjusted annual rate says so in its value header and its unit column", async () => {
  serveSeries(() => ({
    observations: [{ date: "2026-04-01", value: 1152.4 }, { date: "2026-01-01", value: 1131.9 }],
    info: { id: "FDEFX", units: "Billions of Dollars", frequency: "Quarterly", seasonalAdjustment: "Seasonally Adjusted Annual Rate", observationStart: "1947-01-01" },
  }));
  const { result, text } = await runFred(["FDEFX"]);
  expect(text.split("\n")[0]).toBe("Date        Value (Billions of Dollars, annual rate)");
  expect(text.split("\n").at(-1)).toBe("Source: FRED \u00b7 Q2 2026 (quarterly) \u00b7 not a live feed (published statistics)");
  expect(result.data[0]).toEqual({ date: "2026-04-01", value: 1152.4 });
  expect(result.metadata).toMatchObject({ unit: "Billions of Dollars, annual rate", interval: "quarterly" });
  // A monthly total that is not annualized keeps FRED's units alone.
  serveSeries(() => ({
    observations: [{ date: "2026-08-01", value: 653210 }],
    info: { id: "MTSO133FMS", units: "Millions of Dollars", frequency: "Monthly", seasonalAdjustment: "Not Seasonally Adjusted" },
  }));
  expect((await runFred(["MTSO133FMS"])).text.split("\n")[0]).toBe("Date        Value (Millions of Dollars)");
});

test("yield-curve reads each tenor's move against the previous observation, not calendar yesterday", async () => {
  // Monday's reading against Friday's; the 30Y has only one observation to read.
  const history: Record<string, Array<{ date: string; value: number }>> = {
    DGS3MO: [{ date: "2026-10-12", value: 4.25 }, { date: "2026-10-09", value: 4.25 }],
    DGS2: [{ date: "2026-10-12", value: 4.8 }, { date: "2026-10-09", value: 4.84 }],
    DGS10: [{ date: "2026-10-12", value: 5.241 }, { date: "2026-10-09", value: 5.2 }],
    DGS30: [{ date: "2026-10-12", value: 5.6 }],
  };
  setCloudApiFetchTransport(async (url) => {
    const series = new URL(url).pathname.split("/").pop()!;
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ observations: history[series], info: { id: series, title: series } }) } as Response;
  });
  const cli = createTestCliContext();
  await overviewCliCommands.find((command) => command.name === "yield-curve")!.execute([], cli.context);
  const { result, options } = cli.printed[0]!;
  expect(result.data.map((row: Record<string, unknown>) => [row.seriesId, row.previousDate, row.changeBasisPoints]))
    .toEqual([["DGS3MO", "2026-10-09", 0], ["DGS2", "2026-10-09", -4], ["DGS10", "2026-10-09", 4.1], ["DGS30", null, null]]);
  const rows = serializeCliResult({ ...result, freshness: undefined }, DEFAULT_CLI_OPTIONS, options).split("\n").slice(2).map((line) => line.split(/\s+/));
  expect(rows.map(([tenor, yieldText, change]) => [tenor, yieldText, change])).toEqual([["3M", "4.25", "0.0bp"], ["2Y", "4.80", "-4.0bp"], ["10Y", "5.24", "+4.1bp"], ["30Y", "5.60", "-"]]);
});

test("every export dates a figure by the period it covers, when it was released and when it was retrieved, and as_of is the release", async () => {
  // Permits for September are dated 1 Sep and were released 20 Oct; August's release is not stated.
  serveSeries(() => ({
    observations: [{ date: "2026-09-01", value: 1400, releasedOn: "2026-10-20" }, { date: "2026-08-01", value: 1403 }],
    info: { id: "PERMIT", units: "Thousands of Units", frequency: "Monthly", observationStart: "1960-01-01", observationEnd: "2026-09-01" },
  }));
  const { result, options } = await runFred(["PERMIT", "--start", "2026-08-01"]);
  const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n");
  const retrieved = (result.freshness as { retrievedAt: string }).retrievedAt;
  expect(csv[0]).toBe("date,value,symbol_or_series,currency_or_unit,interval,source,as_of,period,released,retrieved");
  // The period's first day is never the as-of: the release is, and a month with none says none.
  expect(csv[1]).toBe(`2026-09-01,1400,PERMIT,Thousands of Units,monthly,FRED,2026-10-20,2026-09-01,2026-10-20,${retrieved}`);
  expect(csv[2]).toBe(`2026-08-01,1403,PERMIT,Thousands of Units,monthly,FRED,,2026-08-01,,${retrieved}`);
  // NDJSON and JSON say the same release, the JSON beside the period the row's date is.
  const [newest] = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "ndjson" }, options).split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(newest).toMatchObject({ date: "2026-09-01", as_of: "2026-10-20", period: "2026-09-01", released: "2026-10-20", retrieved });
  const json = JSON.parse(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, options)) as { data: Array<Record<string, unknown>>; source: Record<string, unknown> };
  expect(json.data[0]).toEqual({ date: "2026-09-01", value: 1400, released: "2026-10-20" });
  expect(json.source).toMatchObject({ retrievalTime: retrieved });
});
