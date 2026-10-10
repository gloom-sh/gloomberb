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

/** The text `econ` prints for `args` against a calendar of `events`, read fresh each time. */
async function econText(events: unknown[], args: string[], cliOptions: Partial<CliGlobalOptions> = {}): Promise<string> {
  resetEconCalendarPersistence();
  attachEconCalendarPersistence(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(events),
  }) as Response);
  const cli = createTestCliContext({}, cliOptions);
  await econ.execute(args, cli.context);
  const { result, options } = cli.printed[0]!;
  return serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, ...cliOptions, format: "text" }, options);
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
});

test("a calendar two weeks ahead lists from today on a Saturday, with nothing to flag", async () => {
  const text = await econText(twoWeeks, ["--impact", "high"]);
  expect(text).toContain("Core Inflation Rate YoY");
  expect(text).toContain("Housing Starts");
  expect(text).not.toContain("Employment Change");
  expect(text).not.toContain("No events listed after");
});
