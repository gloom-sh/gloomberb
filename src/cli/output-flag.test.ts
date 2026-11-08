import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchCli } from "./index";
import { captureConsole } from "../test-support/console";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
afterEach(async () => {
  process.env.HOME = originalHome;
  process.exitCode = 0;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gloom-output-flag-"));
  tempDirs.push(dir);
  process.env.HOME = dir;
  return dir;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

// `financials MSFT --csv > msft.csv` is UTF-16 in Windows PowerShell 5.1; --output writes UTF-8 in every shell.
test("--output writes JSON and NDJSON in UTF-8 with no byte order mark, says Replaced over a file, and refuses a folder", async () => {
  const dir = await folder();
  const json = join(dir, "version.json");
  const saved = await captureConsole(() => dispatchCli(["version", "--json", "--output", json]));
  expect(saved.exitCode ?? 0).toBe(0);
  // The envelope names the file; the export itself went to it.
  expect(JSON.parse(saved.stdout).data).toEqual({ output: json, format: "json", replaced: false });
  const bytes = await readFile(json);
  expect([...bytes.subarray(0, 3)]).not.toEqual(UTF8_BOM);
  expect(JSON.parse(bytes.toString("utf8")).data[0].version).toBeString();

  const ndjson = join(dir, "version.ndjson");
  await writeFile(ndjson, "an older export\n");
  const replaced = await captureConsole(() => dispatchCli(["version", "--ndjson", "--output", ndjson]));
  expect(replaced.stdout).toBe(`Replaced ${ndjson}`);
  const lines = (await readFile(ndjson, "utf8")).trimEnd().split("\n");
  expect(lines.length).toBe(1);
  expect(JSON.parse(lines[0]!).version).toBeString();
  expect([...(await readFile(ndjson)).subarray(0, 3)]).not.toEqual(UTF8_BOM);

  // A folder is named and nothing runs.
  const into = join(dir, "exports");
  await mkdir(into);
  const refused = await captureConsole(() => dispatchCli(["version", "--json", "--output", into]));
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stderr).error.message).toBe(`Cannot write ${into}: it is a folder. Name a file in it, such as ${join(into, "report.csv")}.`);
});

test("a plugin command with its own --output keeps it, and needs no export format; without one, --output is the export's", async () => {
  await folder();
  const plugin = (options?: { flags: string; description: string }[]) => ({
    path: "/tmp/render-plugin",
    plugin: {
      id: "render", name: "Render", version: "1.0.0",
      cliCommands: [{ name: "render", description: "Render", ...options ? { help: { options } } : {},
        execute: (args: string[]) => { console.log(JSON.stringify(args)); } }],
    },
  });
  const own = await captureConsole(() => dispatchCli(["render", "chart", "--output", "chart.svg"], { externalPlugins: [plugin([{ flags: "--output <file>", description: "SVG to write" }])] }));
  expect(own.exitCode ?? 0).toBe(0);
  expect(JSON.parse(own.stdout)).toEqual(["chart", "--output", "chart.svg"]);

  const global = await captureConsole(() => dispatchCli(["render", "chart", "--output", "chart.svg"], { externalPlugins: [plugin()] }));
  expect(global.exitCode).toBe(1);
  expect(global.stderr).toContain("--output writes an export: add --csv, --json or --ndjson");
});
