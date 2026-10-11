import { afterEach, expect, test } from "bun:test";
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
      "Unsupported FRED series DEXSFUS. List supported series with: gloomberb fred --list",
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
function serveSeries(answer: (query: URLSearchParams) => { observations: Array<{ date: string; value: number | null }>; info?: Record<string, unknown> }) {
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
  return { result, text: serializeCliResult(result, DEFAULT_CLI_OPTIONS, options) };
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
  for (const bad of ["1960-13", "99", "abc", "1960-1-1"]) {
    await expect(fred.execute(["T10Y2Y", "--start", bad], createTestCliContext().context))
      .rejects.toThrow(`--start takes a date as yyyy-mm-dd, yyyy-mm or yyyy, got "${bad}".`);
  }
});

test("a spread prints in basis points under a bp header; JSON keeps FRED's percentage points", async () => {
  serveSeries(() => ({ observations: [{ date: "2026-10-09", value: 0.44 }, { date: "2026-10-08", value: -0.125 }], info: T10Y2Y_INFO }));
  const { result, text } = await runFred(["T10Y2Y"]);
  expect(text.split("\n").slice(0, 4)).toEqual(["Date        Value (bp)", "\u2500".repeat(10) + "  " + "\u2500".repeat(10), "2026-10-09          44", "2026-10-08       -12.5"]);
  expect(result.data).toEqual([{ date: "2026-10-09", value: 0.44 }, { date: "2026-10-08", value: -0.125 }]);
  // The default start says it is one.
  expect(text).toContain("Showing from 2021-01-01; earlier: --start YYYY-MM-DD (series begins 1976-06-01).");
});

test("nothing on or after --start names the latest observation", async () => {
  const queries = serveSeries((query) => ({
    observations: query.get("startDate") ? [] : [{ date: "2026-10-09", value: 5.24 }],
    info: { id: "DGS10", units: "Percent", frequency: "Daily", observationStart: "1962-01-02" },
  }));
  const { result, text } = await runFred(["DGS10", "--start", "2026-10-11"]);
  expect(text.split("\n")[0]).toBe("Latest observation: 2026-10-09 (5.24). Nothing on or after 2026-10-11.");
  expect(queries[1]!.get("limit")).toBe("1");
  expect(result.metadata).toMatchObject({ latestObservation: { date: "2026-10-09", value: 5.24 } });
  // A series with no data at all, or a failed second look, keeps the plain answer.
  serveSeries(() => ({ observations: [] }));
  expect((await runFred(["DGS10", "--start", "2026-10-11"])).text.split("\n")[0]).toBe("No results.");
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
  expect(rows.map(([tenor, yieldText, change]) => [tenor, yieldText, change])).toEqual([["3M", "4.25", "0bp"], ["2Y", "4.80", "-4bp"], ["10Y", "5.24", "+4bp"], ["30Y", "5.60", "-"]]);
});
