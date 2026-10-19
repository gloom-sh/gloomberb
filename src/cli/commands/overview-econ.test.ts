import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../api-client/request";
import { DEFAULT_CLI_OPTIONS, type CliGlobalOptions } from "../options";
import { serializeCliResult } from "../result";
import { createTestCliContext } from "../../test-support/cli-context";
import { attachEconCalendarPersistence, resetEconCalendarPersistence } from "../../plugins/builtin/econ/calendar-model";
import { MemoryPluginPersistence } from "../../test-support/plugin-persistence";
import { overviewCliCommands } from "./overview";

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
  const { result, options } = cli.printed[0]!;
  // Warnings print apart from the table, as `warning: ...` lines.
  return [serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, ...cliOptions, format: "text" }, options),
    ...(result.warnings ?? []).map((warning) => `warning: ${warning}`)].join("\n");
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
  await expect(econText(twoWeeks, ["--from", "2025-01-01", "--country", "US"], {}, 422)).rejects.toThrow("The calendar reaches back 400 days");
});

test("a calendar two weeks ahead lists from today on a Saturday, with nothing to flag", async () => {
  const text = await econText(twoWeeks, ["--impact", "high"]);
  expect(text).toContain("Core Inflation Rate YoY");
  expect(text).toContain("Housing Starts");
  expect(text).not.toContain("Employment Change");
  expect(text).not.toContain("No events listed after");
});
