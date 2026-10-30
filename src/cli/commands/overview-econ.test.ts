import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../api-client/request";
import { DEFAULT_CLI_OPTIONS, type CliGlobalOptions } from "../options";
import { printCliResult, serializeCliResult } from "../result";
import { setCliPlainOverride } from "../../utils/cli-output";
import { isCliFailure } from "../errors";
import { createTestCliContext } from "../../test-support/cli-context";
import { attachEconCalendarPersistence, resetEconCalendarPersistence } from "../../plugins/builtin/econ/calendar-model";
import { MemoryPluginPersistence } from "../../test-support/plugin-persistence";
import { overviewCliCommands } from "./overview";
import { dispatchCli } from "../index";
import { captureConsole } from "../../test-support/console";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const econ = overviewCliCommands.find((command) => command.name === "econ")!;

function event(date: string, country: string, impact: string, name: string) {
  return { id: `${date}-${name}`, date, time: date.slice(11, 16), country, event: name, impact, actual: null, forecast: null, prior: null };
}

// The week feed alone: Sunday to Friday, read on the Saturday after.
const weekOnly = [
  event("2026-10-07T18:00:00.000Z", "US", "high", "FOMC Meeting Minutes"),
  event("2026-10-09T12:30:00.000Z", "CA", "high", "Employment Change"),
];
const twoWeeks = [
  ...weekOnly,
  event("2026-10-12T09:00:00.000Z", "EU", "medium", "German ZEW Economic Sentiment"),
  event("2026-10-14T12:30:00.000Z", "US", "high", "Core Inflation Rate YoY"),
  event("2026-10-23T12:30:00.000Z", "US", "high", "Housing Starts"),
];

/**
 * The text `econ` prints for `args` against a calendar of `events`, read fresh
 * each time. The stored calendar answers an earlier --from with the same
 * events and `storedFrom`; "none" is a server that keeps no past events (404),
 * a number another status and "offline" no network for it.
 */
async function econText(events: unknown[], args: string[], cliOptions: Partial<CliGlobalOptions> = {}, storedFrom: string | null | "none" | "offline" | number = "none"): Promise<string> {
  const { result, options } = await econPrinted(events, args, cliOptions, storedFrom);
  // Warnings print apart from the table, as `warning: ...` lines.
  return [serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, ...cliOptions, format: "text" }, options),
    ...(result.warnings ?? []).map((warning) => `warning: ${warning}`)].join("\n");
}

async function econPrinted(events: unknown[], args: string[], cliOptions: Partial<CliGlobalOptions> = {}, storedFrom: string | null | "none" | "offline" | number = "none") {
  resetEconCalendarPersistence();
  attachEconCalendarPersistence(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async (url) => {
    const history = new URL(url).pathname.endsWith("/calendar/history");
    if (history && storedFrom === "offline") throw new TypeError("fetch failed");
    const status = !history ? 200 : storedFrom === "none" ? 404 : typeof storedFrom === "number" ? storedFrom : 200;
    return {
      ok: status === 200,
      status,
      headers: new Headers(),
      text: async () => status === 422 ? JSON.stringify({ message: "The calendar reaches back 400 days" })
        : status !== 200 ? JSON.stringify({ message: "Unavailable" }) : JSON.stringify(history ? { events, storedFrom } : events),
    } as Response;
  });
  const cli = createTestCliContext({}, cliOptions);
  await econ.execute(args, cli.context);
  return cli.printed[0]!;
}

beforeEach(() => setSystemTime(new Date("2026-10-10T13:00:00.000Z")));
afterEach(() => {
  setSystemTime();
  setCloudApiFetchTransport(null);
  resetEconCalendarPersistence();
});

test("a calendar that ended with last week says so instead of listing last week", async () => {
  for (const args of [[], ["--country", "US", "--impact", "high"]]) {
    const text = await econText(weekOnly, args);
    expect(text).toContain("No events listed after 2026-10-09.");
    expect(text).not.toContain("FOMC");
  }
  // The past stays reachable, with where the listing stops under the rows.
  const tail = await econText(weekOnly, [], { tail: 1 });
  expect(tail).toContain("Employment Change");
  expect(tail).toContain("No events listed after 2026-10-09");
  const from = await econText(weekOnly, ["--from", "2026-10-07", "--country", "US"]);
  expect(from).toContain("FOMC Meeting Minutes");
  // A month-name date, as a shell passes the quoted "Oct 1 2026", reads as the same kind of day.
  expect(await econText(weekOnly, ["--from", "Oct 1 2026", "--country", "US"])).toContain("FOMC Meeting Minutes");
});

test("an earlier --from lists the stored calendar's past events and says where it starts", async () => {
  // Read on the Sunday after: the current week's listing no longer holds last week's CPI; the stored calendar does.
  setSystemTime(new Date("2026-10-18T23:00:00.000Z"));
  const stored = await econText(twoWeeks, ["--from", "2026-10-12", "--country", "US"], {}, "2026-09-01");
  expect(stored).toContain("Core Inflation Rate YoY");
  expect(stored).not.toContain("The stored calendar starts");
  const late = await econText(twoWeeks, ["--from", "2026-08-01", "--country", "US"], {}, "2026-09-01");
  expect(late).toContain("The stored calendar starts 2026-09-01; nothing earlier is listed");
  // A server that keeps no past events lists what it has and says where that starts.
  const old = await econText(twoWeeks.slice(4), ["--from", "2026-10-12", "--country", "US"]);
  expect(old).toContain("Housing Starts");
  expect(old).toContain("No events are stored before 2026-10-23");
  // So does a server error or no network, saying the stored calendar was not read; a refused date keeps the server's message.
  for (const [answer, why] of [[503, "server error 503"], ["offline", "the server could not be reached"]] as const) {
    const text = await econText(twoWeeks.slice(4), ["--from", "2026-10-12", "--country", "US"], {}, answer);
    expect(text).toContain("Housing Starts");
    expect(text).toContain("No events are stored before 2026-10-23");
    expect(text).toContain(`The stored calendar could not be read (${why}); listing the current calendar`);
  }
});

test("a --from before the stored calendar reaches is an input error naming the earliest day", async () => {
  // 400 days before Sunday 18 Oct 2026.
  setSystemTime(new Date("2026-10-18T23:00:00.000Z"));
  const error = await econText(twoWeeks, ["--from", "2025-01-01", "--country", "US"], {}, 422).catch((caught: unknown) => caught);
  expect(isCliFailure(error)).toBe(true);
  if (!isCliFailure(error)) return;
  expect(error.code).toBe("cli_error");
  expect(error.message).toBe("--from 2025-01-01 is before the earliest day the calendar reaches back to, 2025-09-13. Use --from 2025-09-13 or later.");
  expect(error.fields).toEqual({ earliest: "2025-09-13", days: 400 });
  // The earliest day itself is read, not refused.
  expect(await econText(twoWeeks, ["--from", "2025-09-13", "--country", "US"], {}, "2025-09-01")).toContain("Core Inflation Rate YoY");
});

test("a calendar two weeks ahead lists from today on a Saturday, with nothing to flag", async () => {
  const text = await econText(twoWeeks, ["--impact", "high"]);
  expect(text).toContain("Core Inflation Rate YoY");
  expect(text).toContain("Housing Starts");
  expect(text).not.toContain("Employment Change");
  expect(text).not.toContain("No events listed after");
});

test("--country takes ISO codes, comma lists and regions; a country with nothing scheduled says so plainly", async () => {
  const withTurkey = [...twoWeeks, { ...event("2026-11-03T07:00:00.000Z", "TR", "high", "CPI y/y"), prior: "29.73%" }];
  const turkey = await econText(withTurkey, ["--country", "tr"]);
  expect(turkey).toContain("CPI y/y");
  expect(turkey).toContain("29.73%");
  expect(turkey).not.toContain("Housing Starts");
  // A real country with no rows is a quiet window, never an unknown country; UK is GB's common name.
  expect(await econText(withTurkey, ["--country", "MX"])).toContain("No scheduled releases for MX in this window.");
  expect(await econText(withTurkey, ["--country", "UK"])).toContain("No scheduled releases for GB in this window.");
  // A list lists what its countries have, and names the ones with nothing.
  const list = await econText(withTurkey, ["--country", "MX,tr, us"]);
  expect(list).toContain("CPI y/y");
  expect(list).toContain("Housing Starts");
  expect(list).not.toContain("German ZEW");
  expect(list).toContain("No scheduled releases for MX in this window.");
  await expect(econText(withTurkey, ["--country", "TUR"])).rejects.toThrow('Unknown country "TUR".');
  await expect(econText(withTurkey, ["--country", "MX,XQ"])).rejects.toThrow('Unknown country "XQ".');
});

test("rows a bank or a statistics office times itself show its clock; a bank that states no time leaves the time blank and says why", async () => {
  const added = [
    ...twoWeeks,
    { ...event("2026-10-22T12:00:00.000Z", "MX", "high", "Mid-Month CPI"), kind: "statistics-release", localTime: "06:00",
      timeZone: "America/Mexico_City", source: { name: "INEGI", url: "https://www.inegi.org.mx/app/saladeprensa/calendario" } },
    { ...event("2026-10-22T00:00:00.000Z", "TR", "high", "CBRT Interest Rate Decision"), time: "All Day", kind: "central-bank-decision",
      localTime: null, timeZone: "Europe/Istanbul", timeNote: "The bank's calendar gives the day, not the time", prior: "39.50%", priorAsOf: "2026-10-16" },
  ];
  const text = await econText(added, ["--country", "MX,TR"]);
  expect(text).toMatch(/2026-10-22\s+Thu\s+12:00 UTC\s+06:00 Mexico City\s+MX\s+high\s+Mid-Month CPI/);
  expect(text).toMatch(/2026-10-22\s+Thu\s+TR\s+high\s+CBRT Interest Rate Decision\s+39\.50%/);
  expect(text).toContain("No time for CBRT Interest Rate Decision (TR): the bank's calendar gives the day, not the time.");
  const [row] = (await econPrinted(added, ["--country", "TR"])).result.data as Record<string, unknown>[];
  expect(row).toMatchObject({ time: "", localTime: null, timeZone: "Europe/Istanbul", priorAsOf: "2026-10-16", prior: 39.5, priorText: "39.50%", actual: null });
  // The feeds' own calendar prints without the publisher's clock column.
  expect(await econText(twoWeeks, ["--country", "US"])).not.toContain("Local");
});

test("plain output, which keeps every column a query has, leaves out the Local and Viewer columns when nothing fills them", async () => {
  const timed = { ...event("2026-10-22T12:00:00.000Z", "MX", "high", "Mid-Month CPI"), localTime: "06:00", timeZone: "America/Mexico_City" };
  setCliPlainOverride(true);
  try {
    // A calendar of the feeds' own rows has no publisher clock and, without --tz, no viewer clock: no column of dashes for either.
    const feeds = await econText(twoWeeks, ["--country", "US"]);
    expect(feeds).toMatch(/Date\s+Day\s+Time\s+Country\s+Impact\s+Event\s+Actual\s+Forecast\s+Prior/);
    expect(feeds).not.toContain("Local");
    expect(feeds).not.toContain("Viewer");
    // One row a publisher times itself brings the column back, with the dash on the rows that have none.
    const mixed = await econText([...twoWeeks, timed], ["--country", "US,MX"]);
    expect(mixed).toMatch(/Time\s+Local\s+Country/);
    expect(mixed).toMatch(/12:00 UTC\s+06:00 Mexico City\s+MX\s+high\s+Mid-Month CPI/);
    expect(mixed).toMatch(/12:30 UTC\s+—\s+US\s+high\s+Housing Starts/);
    // --tz gives the viewer's clock its column, named for the zone.
    expect(await econText(twoWeeks, ["--country", "US", "--tz", "America/New_York"])).toMatch(/Time\s+Day\s+New York\s+Country/);
    // A script's CSV header keeps both columns whatever the rows hold.
    const { result, options } = await econPrinted(twoWeeks, ["--country", "US"]);
    expect(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n")[0]).toContain("Viewer,Local");
  } finally {
    setCliPlainOverride(null);
  }
});

test("a row names who publishes it, the period it covers and its page, in the table and in every export", async () => {
  const mortgages = [
    ...twoWeeks,
    { ...event("2026-10-21T11:00:00.000Z", "US", "low", "MBA 30-Year Mortgage Rate"), actual: "7.48%", referencePeriod: "16 Oct 2026",
      source: { name: "Mortgage Bankers Association", url: "https://www.mba.org/" } },
    { ...event("2026-10-22T16:00:00.000Z", "US", "medium", "30-Year Mortgage Rate"), actual: "7.32%", prior: "7.40%", referencePeriod: "22 Oct 2026",
      source: { name: "Freddie Mac", url: "https://www.freddiemac.com/" } },
    // A publisher named without a page keeps its name.
    { ...event("2026-10-22T14:30:00.000Z", "US", "low", "EIA Natural Gas Stocks Change"), source: { name: "Energy Information Administration" } },
  ];
  const rows = (await econPrinted(mortgages, ["--country", "US"])).result.data as Record<string, unknown>[];
  expect(rows.find((row) => row.event === "30-Year Mortgage Rate")).toMatchObject({
    publisher: "Freddie Mac", referencePeriod: "22 Oct 2026", sourceUrl: "https://www.freddiemac.com/", actual: 7.32, actualText: "7.32%",
  });
  expect(rows.find((row) => row.event === "MBA 30-Year Mortgage Rate")).toMatchObject({ publisher: "Mortgage Bankers Association", referencePeriod: "16 Oct 2026" });
  expect(rows.find((row) => row.event === "EIA Natural Gas Stocks Change")).toMatchObject({ publisher: "Energy Information Administration", sourceUrl: null });
  // The feed's own rows name nobody.
  expect(rows.find((row) => row.event === "Housing Starts")).toMatchObject({ publisher: null, referencePeriod: null, sourceUrl: null });
  const text = await econText(mortgages, ["--country", "US"]);
  expect(text).toMatch(/Publisher/);
  expect(text).toMatch(/30-Year Mortgage Rate\s+7\.32%\s+7\.40%\s+Freddie Mac/);
  // A calendar without publishers prints no empty column for them.
  expect(await econText(twoWeeks, ["--country", "US"])).not.toContain("Publisher");
});

test("--tz adds the viewer's clock, with the weekday there in Day", async () => {
  const brazil = [
    ...twoWeeks,
    { ...event("2026-10-23T12:00:00.000Z", "BR", "high", "IPCA-15 Mid-Month CPI m/m"), kind: "statistics-release", localTime: "09:00",
      timeZone: "America/Sao_Paulo", actual: "0.32%", forecast: "0.43%", prior: "0.70%", referencePeriod: "2026-10" },
    // 01:30 UTC on the 14th is still the 13th in New York.
    { ...event("2026-10-14T01:30:00.000Z", "BR", "medium", "Night release") },
  ];
  const text = await econText(brazil, ["--country", "BR", "--tz", "america/new_york"]);
  expect(text).toMatch(/Date\s+Time\s+Day\s+New York\s+Local/);
  // Wednesday the 14th in UTC is still Tuesday evening in New York.
  expect(text).toMatch(/2026-10-14\s+01:30 UTC\s+Tue\s+21:30\s+BR\s+medium\s+Night release/);
  expect(text).toMatch(/2026-10-23\s+12:00 UTC\s+Fri\s+08:00\s+09:00 Sao Paulo\s+BR\s+high\s+IPCA-15 Mid-Month CPI m\/m\s+0\.32%\s+0\.43%\s+0\.70%/);
  const printed = await econPrinted(brazil, ["--country", "BR", "--tz", "America/New_York"]);
  expect(printed.result.metadata).toMatchObject({ timeZone: "America/New_York" });
  expect((printed.result.data as Record<string, unknown>[]).at(-1)).toMatchObject({ viewerDate: "2026-10-23", viewerTime: "08:00" });
  // Without --tz the rows carry no viewer clock, and Day is the UTC date's.
  const plain = await econText(brazil, ["--country", "BR"]);
  expect(plain).not.toContain("New York");
  expect(plain).not.toContain("Viewer");
  expect(plain).toMatch(/2026-10-14\s+Wed\s+01:30 UTC\s+BR\s+medium\s+Night release/);
  await expect(econText(brazil, ["--tz", "EST5"])).rejects.toThrow('Unknown time zone "EST5"');
});

test("a day-long event prints All day under its own weekday, never a midnight clock", async () => {
  // A plenum the calendar lists for the day, beside a release timed at midnight UTC.
  const china = [
    ...twoWeeks,
    { ...event("2026-10-12T00:00:00.000Z", "CN", "medium", "Communist Party Fifth Plenum"), time: "All Day" },
    { ...event("2026-10-12T00:00:00.000Z", "CN", "low", "Midnight release"), prior: "1.2" },
  ];
  const text = await econText(china, ["--country", "CN"]);
  expect(text).toMatch(/2026-10-12\s+Mon\s+All day\s+CN\s+medium\s+Communist Party Fifth Plenum/);
  expect(text).toMatch(/2026-10-12\s+Mon\s+00:00 UTC\s+CN\s+low\s+Midnight release/);
  // Its day stays its own on another clock, which has no time to show for it.
  const newYork = await econText(china, ["--country", "CN", "--tz", "America/New_York"]);
  expect(newYork).toMatch(/2026-10-12\s+All day\s+Mon\s+CN\s+medium\s+Communist Party Fifth Plenum/);
  expect(newYork).toMatch(/2026-10-12\s+00:00 UTC\s+Sun\s+20:00\s+CN\s+low\s+Midnight release/);
  const rows = (await econPrinted(china, ["--country", "CN", "--tz", "America/New_York"])).result.data as Record<string, unknown>[];
  expect(rows.map((row) => [row.event, row.time, row.day, row.viewerTime])).toEqual([
    ["Communist Party Fifth Plenum", "All Day", "Mon", null],
    ["Midnight release", "00:00", "Sun", "20:00"],
  ]);
});

/** A CSV as its header and rows of cells, quoted cells and doubled quotes read back; closing `#` lines apart. */
function readCsv(text: string): { header: string[]; rows: string[][]; footer: string[] } {
  const [body = "", ...footer] = text.split(/\n\n(?=#)/);
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') { cell += '"'; index += 1; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { cells.push(cell); cell = ""; }
    else if (char === "\n") { cells.push(cell); rows.push(cells); cells = []; cell = ""; }
    else cell += char;
  }
  if (cell || cells.length > 0) rows.push([...cells, cell]);
  const [header = [], ...rest] = rows;
  return { header, rows: rest, footer: footer.flatMap((block) => block.split("\n")) };
}

const exportCalendar = [
  ...twoWeeks,
  // A feed row with every figure drawn as text, and a publisher, period and page.
  { ...event("2026-10-14T06:00:00.000Z", "GB", "low", "Claimant Count Change"), actual: "30.3K", forecast: "19.4K", prior: "-27.8K", referencePeriod: "Sep 2026",
    source: { name: "Office for National Statistics", url: "https://www.ons.gov.uk/" },
    consensus: { source: "release-calendar", readAt: "2026-10-09T08:00:00.000Z" } },
  { ...event("2026-10-14T14:30:00.000Z", "US", "medium", "EIA Crude Oil Stocks Change"), actual: "-4.1M bbl", forecast: "-0.987M bbl", prior: "0.5M bbl", referencePeriod: "9 Oct 2026",
    source: { name: "U.S. Energy Information Administration", url: "https://www.eia.gov/" } },
  { ...event("2026-10-14T12:30:00.000Z", "US", "high", "Unemployment Rate"), actual: "4.7%", forecast: "4.9%", prior: "4.9%", referencePeriod: "Sep 2026", indicatorId: "us-unemployment-rate",
    consensus: { source: "week-feed", readAt: "2026-10-09T08:30:00.000Z" } },
  { ...event("2026-10-15T14:30:00.000Z", "US", "low", "EIA Natural Gas Stocks Change"), forecast: "77 Bcf", prior: "-119 Bcf" },
  // A bound is no single number, and a release with nothing out yet has no release time.
  { ...event("2026-10-30T02:30:00.000Z", "JP", "high", "BOJ Policy Rate"), forecast: "<1.25%", prior: "0.5%" },
  { ...event("2026-10-20T00:00:00.000Z", "CN", "medium", "Party Plenum"), time: "All Day", actual: "1" },
];

test("an export carries the calendar's figures as numbers with their unit and scale, null where there is none", async () => {
  const { result } = await econPrinted(exportCalendar, ["--from", "2026-10-14"]);
  const rows = result.data as Record<string, unknown>[];
  const by = (name: string) => rows.find((row) => row.event === name)!;
  // A scale is multiplied out, exactly: 0.987M is 987000, and the scale says how it was drawn.
  expect(by("Claimant Count Change")).toMatchObject({ actual: 30300, forecast: 19400, prior: -27800, unit: null, scale: 1000, actualText: "30.3K" });
  expect(by("EIA Crude Oil Stocks Change")).toMatchObject({ actual: -4_100_000, forecast: -987_000, prior: 500_000, unit: "bbl", scale: 1_000_000, priorText: "0.5M bbl" });
  expect(by("Unemployment Rate")).toMatchObject({ actual: 4.7, forecast: 4.9, prior: 4.9, unit: "%", scale: 1 });
  expect(by("EIA Natural Gas Stocks Change")).toMatchObject({ actual: null, forecast: 77, prior: -119, unit: "Bcf", scale: 1, actualText: null });
  // A bound is not a figure; the text it was drawn as stays.
  expect(by("BOJ Policy Rate")).toMatchObject({ actual: null, forecast: null, prior: 0.5, unit: "%", forecastText: "<1.25%" });
  // A row with no figures has no unit or scale.
  expect(by("Housing Starts")).toMatchObject({ actual: null, forecast: null, prior: null, unit: null, scale: null });
  // The text table still draws them as they were.
  const text = await econText(exportCalendar, ["--from", "2026-10-14"]);
  expect(text).toMatch(/Claimant Count Change\s+30\.3K\s+19\.4K\s+-27\.8K/);
  expect(text).toMatch(/EIA Crude Oil Stocks Change\s+-4\.1M bbl\s+-0\.987M bbl\s+0\.5M bbl/);
  expect(text).not.toContain("Scale");
});

test("the CSV, NDJSON and JSON of the same calendar say the same, and the CSV adds nothing the JSON lacks", async () => {
  const { result, options } = await econPrinted(exportCalendar, ["--from", "2026-10-14"]);
  const json = JSON.parse(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, options)) as {
    data: Record<string, unknown>[]; columns: Array<{ key: string; header: string }>; metadata: { freshness: { retrievedAt: string } };
  };
  const csv = readCsv(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options));
  const ndjson = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "ndjson" }, options).split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  // Every column the JSON lists is in the CSV, in order, then the fixed ones every dated export ends with.
  expect(csv.header).toEqual([
    ...json.columns.map((column) => column.header),
    "symbol_or_series", "currency_or_unit", "interval", "source", "as_of", "period", "released", "retrieved",
  ]);
  expect(csv.header.slice(0, json.columns.length)).toEqual(["Date", "Day", "Time", "Viewer", "Local", "Country", "Impact", "Event", "Actual", "Forecast", "Prior", "Unit", "Scale", "Publisher", "Link", "actual_text", "forecast_text", "prior_text", "consensus_feed", "consensus_read_at"]);
  expect(csv.rows).toHaveLength(json.data.length);
  expect(ndjson).toHaveLength(json.data.length);
  const cell = (value: unknown) => value == null ? "" : String(value);
  json.data.forEach((row, index) => {
    const cells = Object.fromEntries(csv.header.map((name, column) => [name, csv.rows[index]![column]!]));
    for (const column of json.columns) expect(cells[column.header]).toBe(cell(row[column.key]));
    // The fixed columns say what the row's own fields do: the release is the as-of, the period is the reference period.
    expect(cells.as_of).toBe(cell(row.released));
    expect(cells.released).toBe(cell(row.released));
    expect(cells.period).toBe(cell(row.referencePeriod));
    // A percent is `pct` in the unit column, as in `fred` and `yield-curve`; `unit` itself keeps the `%` drawn.
    expect(cells.currency_or_unit).toBe(row.unit === "%" ? "pct" : cell(row.unit));
    expect(cells.symbol_or_series).toBe(cell(row.indicatorId));
    expect(cells.retrieved).toBe(json.metadata.freshness.retrievedAt);
    // NDJSON is the JSON row with the fixed fields, a publisher's own `released` untouched.
    expect(ndjson[index]).toMatchObject({ ...row, as_of: row.released, period: row.referencePeriod ?? null, retrieved: json.metadata.freshness.retrievedAt, source: "Gloom Cloud" });
  });
  // The indicator id the server sends is the series column; none is blank, never made up.
  expect(json.data.find((row) => row.event === "Unemployment Rate")).toMatchObject({ indicatorId: "us-unemployment-rate", unit: "%" });
  const unemployment = json.data.findIndex((row) => row.event === "Unemployment Rate");
  expect(csv.rows[unemployment]![csv.header.indexOf("symbol_or_series")]).toBe("us-unemployment-rate");
  expect(csv.rows[unemployment]![csv.header.indexOf("currency_or_unit")]).toBe("pct");
  expect(ndjson[unemployment]).toMatchObject({ symbol_or_series: "us-unemployment-rate", currency_or_unit: "pct", unit: "%" });
  expect(json.data.find((row) => row.event === "Housing Starts")).toMatchObject({ indicatorId: null });
  // The text columns keep what was drawn, so a bound that is no number keeps its words in every format.
  const boj = json.data.findIndex((row) => row.event === "BOJ Policy Rate");
  const bojCells = Object.fromEntries(csv.header.map((name, column) => [name, csv.rows[boj]![column]!]));
  expect([bojCells.Forecast, bojCells.forecast_text, bojCells.Prior, bojCells.prior_text]).toEqual(["", "<1.25%", "0.5", "0.5%"]);
  expect(ndjson[boj]).toMatchObject({ forecast: null, forecastText: "<1.25%", prior: 0.5, priorText: "0.5%" });
  expect(json.data[boj]).toMatchObject({ forecast: null, forecastText: "<1.25%" });
  // The feed a forecast was read from and when, in every format; a row with no forecast names none.
  const claimant = json.data.findIndex((row) => row.event === "Claimant Count Change");
  expect(json.data[claimant]).toMatchObject({ consensusFeed: "release-calendar", consensusReadAt: "2026-10-09T08:00:00.000Z" });
  expect(ndjson[claimant]).toMatchObject({ consensusFeed: "release-calendar", consensusReadAt: "2026-10-09T08:00:00.000Z" });
  const claimantCells = Object.fromEntries(csv.header.map((name, column) => [name, csv.rows[claimant]![column]!]));
  expect([claimantCells.consensus_feed, claimantCells.consensus_read_at]).toEqual(["release-calendar", "2026-10-09T08:00:00.000Z"]);
  expect(json.data[unemployment]).toMatchObject({ consensusFeed: "week-feed", consensusReadAt: "2026-10-09T08:30:00.000Z" });
  expect(csv.rows[unemployment]![csv.header.indexOf("consensus_feed")]).toBe("week-feed");
  expect(json.data.find((row) => row.event === "Housing Starts")).toMatchObject({ consensusFeed: null, consensusReadAt: null });
  expect(csv.rows[json.data.findIndex((row) => row.event === "Housing Starts")]!.slice(csv.header.indexOf("consensus_feed"), csv.header.indexOf("consensus_read_at") + 1)).toEqual(["", ""]);
  // A figure is a number in every format, and a missing one is empty in CSV and null in JSON.
  const crude = json.data.findIndex((row) => row.event === "EIA Crude Oil Stocks Change");
  expect(csv.rows[crude]!.slice(8, 13)).toEqual(["-4100000", "-987000", "500000", "bbl", "1000000"]);
  const housing = json.data.findIndex((row) => row.event === "Housing Starts");
  expect(csv.rows[housing]!.slice(8, 13)).toEqual(["", "", "", "", ""]);
  expect(json.data[housing]).toMatchObject({ actual: null, released: null });
  // Released once it has an actual: a day alone for a row with no time, an instant otherwise.
  expect(json.data.find((row) => row.event === "Unemployment Rate")).toMatchObject({ released: "2026-10-14T12:30:00.000Z" });
  expect(json.data.find((row) => row.event === "Party Plenum")).toMatchObject({ released: "2026-10-20" });
});

test("a capped export says so after its rows, as text and JSON do", async () => {
  const many = Array.from({ length: 60 }, (_, index) => event(`2026-10-1${index % 10}T${String(index % 24).padStart(2, "0")}:00:00.000Z`, "US", "low", `Release ${index}`));
  const { result, options } = await econPrinted(many, ["--from", "2026-10-10"]);
  const note = "showing the oldest 50 of 60 rows; --tail 50 for the latest";
  const csv = readCsv(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options));
  expect(csv.rows).toHaveLength(50);
  expect(csv.footer).toContain(`# note: ${note}`);
  const json = JSON.parse(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, options)) as { metadata: { rows: { note: string } } };
  expect(json.metadata.rows.note).toBe(note);
  expect((await econText(many, ["--from", "2026-10-10"]))).toContain(note);
  // A window that holds all its rows has nothing to say.
  const { result: fewer, options: fewerOptions } = await econPrinted(many.slice(0, 5), ["--from", "2026-10-10"]);
  expect(serializeCliResult(fewer, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, fewerOptions)).not.toContain("showing the oldest");
});

test("a CSV carries what the text says under the table, such as where the stored calendar starts", async () => {
  setSystemTime(new Date("2026-10-18T23:00:00.000Z"));
  const { result, options } = await econPrinted(twoWeeks, ["--from", "2026-08-01", "--country", "US"], {}, "2026-09-01");
  const footer = readCsv(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options)).footer;
  expect(footer).toContain("# note: The stored calendar starts 2026-09-01; nothing earlier is listed");
  // NDJSON has no footer: the same note goes to stderr, and stdout stays rows.
  const ndjson = await captureConsole(() => printCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "ndjson" }, options));
  expect(ndjson.stderr).toContain("note: The stored calendar starts 2026-09-01; nothing earlier is listed");
  expect(ndjson.stdout.split("\n").every((line) => line.startsWith("{"))).toBe(true);
});

test("the earliest-day error is the same JSON a script reads, with a failing exit code", async () => {
  setSystemTime(new Date("2026-10-18T23:00:00.000Z"));
  const home = await mkdtemp(join(tmpdir(), "gloom-econ-earliest-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  resetEconCalendarPersistence();
  attachEconCalendarPersistence(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async (url) => {
    const refused = new URL(url).pathname.endsWith("/calendar/history");
    return {
      ok: !refused, status: refused ? 422 : 200, headers: new Headers(),
      text: async () => JSON.stringify(refused ? { message: "The calendar reaches back 400 days" } : twoWeeks),
    } as Response;
  });
  try {
    const { result, stdout, stderr, exitCode } = await captureConsole(() => dispatchCli(["econ", "--from", "2025-01-01", "--json"]));
    expect(result).toEqual({ kind: "handled" });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({
      ok: false,
      error: {
        code: "cli_error",
        message: "--from 2025-01-01 is before the earliest day the calendar reaches back to, 2025-09-13. Use --from 2025-09-13 or later.",
        earliest: "2025-09-13",
        days: 400,
      },
    });
  } finally {
    process.env.HOME = originalHome;
    process.exitCode = 0;
    await rm(home, { recursive: true, force: true });
  }
});

test("a row with no figures comes out at its own time once that has passed, as released and as_of in every format", async () => {
  setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
  const calendar = [
    ...twoWeeks,
    event("2026-10-19T09:00:00.000Z", "GB", "medium", "BoE Bailey Speech"),
    event("2026-10-22T15:00:00.000Z", "GB", "medium", "BoE Pill Speech"),
    { ...event("2026-10-19T00:00:00.000Z", "EU", "low", "Eurogroup Meeting"), time: "All Day" },
    { ...event("2026-10-19T12:30:00.000Z", "US", "low", "Housing Starts"), forecast: "1.3M", prior: "1.4M" },
    { ...event("2026-10-19T14:00:00.000Z", "US", "low", "Existing Home Sales"), actual: "4.1M", forecast: "4.0M", prior: "3.9M" },
  ];
  const { result, options } = await econPrinted(calendar, ["--from", "2026-10-19"]);
  const csv = readCsv(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options));
  const ndjson = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "ndjson" }, options).split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const json = (result.data as Array<Record<string, unknown>>);
  const at = (name: string) => json.findIndex((row) => row.event === name);
  const cells = (name: string) => Object.fromEntries(csv.header.map((header, column) => [header, csv.rows[at(name)]![column]!]));
  // The row's released in JSON, in NDJSON beside its as_of, and in CSV beside its as_of.
  const seen = (name: string) => [json[at(name)]!.released, ndjson[at(name)]!.released, ndjson[at(name)]!.as_of, cells(name).released, cells(name).as_of];
  // A speech given: its own time. A meeting that takes the day: its day.
  expect(seen("BoE Bailey Speech")).toEqual(Array(5).fill("2026-10-19T09:00:00.000Z"));
  expect(seen("Eurogroup Meeting")).toEqual(Array(5).fill("2026-10-19"));
  // A speech still to come has not come out; nor has a release with a forecast and no actual yet, whatever its time.
  expect(seen("BoE Pill Speech")).toEqual([null, null, null, "", ""]);
  expect(seen("Housing Starts")).toEqual([null, null, null, "", ""]);
  // A release with its actual is unchanged.
  expect(seen("Existing Home Sales")).toEqual(Array(5).fill("2026-10-19T14:00:00.000Z"));
});

test("--search finds an event however its name is spaced or hyphenated, and the Fed's rate reads as its upper bound", async () => {
  const calendar = [
    ...twoWeeks,
    { ...event("2026-10-28T18:00:00.000Z", "US", "high", "Federal Funds Rate"), forecast: "4.00%", prior: "4.00%" },
    { ...event("2026-11-06T13:30:00.000Z", "US", "high", "Non Farm Payrolls"), prior: "29K" },
    { ...event("2026-11-06T13:30:00.000Z", "US", "low", "Nonfarm Payrolls Private"), prior: "46K" },
    { ...event("2026-10-30T07:45:00.000Z", "FR", "low", "French Private Non-Farm Payrolls QoQ Prel"), forecast: "-0.1%", prior: "-0.1%" },
  ];
  setSystemTime(new Date("2026-10-28T12:00:00.000Z"));
  const nonfarm = await econPrinted(calendar, ["--search", "nonfarm"]);
  expect((nonfarm.result.data as Array<{ event: string }>).map((row) => row.event))
    .toEqual(["French Private Non-Farm Payrolls QoQ Prel", "Non Farm Payrolls", "Nonfarm Payrolls Private"]);
  // The payrolls have a prior and no forecast yet: the dash under Forecast is a consensus not in yet.
  const text = await econText(calendar, ["--search", "non farm payrolls", "--country", "US"]);
  expect(text).toContain("— forecast = no consensus yet");
  // The policy rate is the top of the Fed's range, searched by the name it is shown under or the feed's.
  for (const words of ["fed funds", "upper bound"]) {
    const rate = await econText(calendar, ["--search", words]);
    expect(rate).toContain("Federal Funds Rate (upper bound)");
    expect(rate).not.toContain("Payrolls");
    // A release with its forecast in leaves the note out.
    expect(rate).not.toContain("no consensus yet");
  }
  expect(await econText(calendar, ["--search", "ism"])).toContain("No matching events");
});

test("--search also finds an event by its publisher's name, initials or site: usda is the WASDE", async () => {
  const usda = { name: "U.S. Department of Agriculture", url: "https://www.usda.gov/" };
  const calendar = [
    ...twoWeeks,
    { ...event("2026-11-10T17:00:00.000Z", "US", "medium", "WASDE Report"), source: usda },
    { ...event("2026-11-06T13:30:00.000Z", "US", "high", "Non Farm Payrolls"), source: { name: "Bureau of Labor Statistics", url: "https://www.bls.gov/" } },
  ];
  setSystemTime(new Date("2026-10-28T12:00:00.000Z"));
  const names = async (words: string) => ((await econPrinted(calendar, ["--search", words])).result.data as Array<{ event: string }>).map((row) => row.event);
  for (const words of ["USDA", "agriculture", "department of agriculture", "usda wasde"]) expect(await names(words), words).toEqual(["WASDE Report"]);
  expect(await names("bls")).toEqual(["Non Farm Payrolls"]);
  // A word in neither the name nor the publisher still finds nothing.
  expect(await names("usda payrolls")).toEqual([]);
});
