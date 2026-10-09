import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../api-client/request";
import { inferCliErrorOptions, printCliError } from "../errors";
import { createTestCliContext } from "../../test-support/cli-context";
import { captureConsole } from "../../test-support/console";
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
