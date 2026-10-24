import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../../data/config/store";
import { createTestCliContext } from "../../test-support/cli-context";
import { createSystemCliCommands } from "./system";

const configCommand = createSystemCliCommands().find((command) => command.name === "config")!;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDataDir(saved?: Record<string, unknown>): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-base-currency-"));
  tempDirs.push(dataDir);
  if (saved) await writeFile(join(dataDir, "config.json"), JSON.stringify({ dataDir, ...saved }), "utf-8");
  return dataDir;
}

async function runConfig(args: string[], dataDir: string) {
  const { context, printed } = createTestCliContext({ config: await loadConfig(dataDir), dataDir });
  await configCommand.execute(args, context);
  return printed.at(-1)!;
}

async function failure(args: string[], dataDir: string): Promise<{ message: string; details: string }> {
  const error = await runConfig(args, dataDir).then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  return { message: (error as Error).message, details: String((error as { details?: unknown }).details) };
}

// GLO-1106: `config set baseCurrency "Canadian dollar"` saved the name, and every conversion then fell back to USD.
test("config set baseCurrency takes an ISO code in any case and refuses a name or sign, naming the code it stands for", async () => {
  const dataDir = await tempDataDir();
  for (const typed of [["Canadian dollar"], ["Canadian", "dollar"], ["CA$"], ["C$"]]) {
    const refused = await failure(["set", "baseCurrency", ...typed], dataDir);
    expect(refused.message).toBe(`"${typed.join(" ")}" is not a currency code. Did you mean CAD?`);
    expect(refused.details).toBe("baseCurrency takes an ISO 4217 code: gloom config set baseCurrency CAD");
  }
  // A sign several currencies write names them, the most traded first; a code that is no currency names none.
  expect((await failure(["set", "baseCurrency", "$"], dataDir)).message).toBe("\"$\" is not a currency code; it can be USD, CAD, AUD, HKD, SGD, NZD.");
  expect(await failure(["set", "baseCurrency", "XYZ"], dataDir)).toEqual({
    message: "\"XYZ\" is not an ISO 4217 currency code.",
    details: "baseCurrency takes an ISO 4217 code such as USD, EUR or CAD.",
  });
  expect((await failure(["set", "baseCurrency", "xau"], dataDir)).message).toBe("XAU is a metal, drawing-right or test code, not a currency.");
  // Nothing was written by the refusals.
  expect((await loadConfig(dataDir)).baseCurrency).toBe("USD");

  expect((await runConfig(["set", "baseCurrency", "cad"], dataDir)).result.data).toMatchObject({ key: "baseCurrency", value: "CAD" });
  expect(JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")).baseCurrency).toBe("CAD");
});

test("a name or sign an older version saved loads as its code; one that names no single currency is kept and flagged, never read as USD", async () => {
  for (const [saved, loaded] of [["Canadian dollar", "CAD"], ["CA$", "CAD"], ["cad", "CAD"], [" eur ", "EUR"]] as const) {
    expect((await loadConfig(await tempDataDir({ baseCurrency: saved }))).baseCurrency).toBe(loaded);
  }
  const ambiguous = await tempDataDir({ baseCurrency: "dollar" });
  expect((await loadConfig(ambiguous)).baseCurrency).toBe("dollar");
  const shown = await runConfig(["get", "baseCurrency"], ambiguous);
  expect(shown.result.data).toEqual({ key: "baseCurrency", value: "dollar" });
  const text = (shown.options!.text as (data: unknown) => string)(shown.result.data).replace(/\u001b\[[0-9;]*m/g, "");
  expect(text).toBe("dollar (\"dollar\" is not a currency code; it can be USD, CAD, AUD, NZD, HKD, SGD. Set one: gloom config set baseCurrency USD)");
});
