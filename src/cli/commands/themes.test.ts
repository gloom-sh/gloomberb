import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../../data/config/store";
import { createTestCliContext } from "../../test-support/cli-context";
import { getThemeColors } from "../../theme/colors";
import { DEFAULT_THEME, getThemeIds } from "../../theme/themes";
import { createSystemCliCommands } from "./system";

const configCommand = createSystemCliCommands().find((command) => command.name === "config")!;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runConfig(args: string[], dataDir: string, dryRun = false) {
  const config = await loadConfig(dataDir);
  const { context, printed } = createTestCliContext({ config, dataDir }, { dryRun });
  await configCommand.execute(args, context);
  return printed.at(-1)!.result.data as Record<string, unknown>;
}

async function tempDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-themes-"));
  tempDirs.push(dataDir);
  return dataDir;
}

test("config set theme refuses an unknown theme, naming the near miss and every id with its name", async () => {
  const dataDir = await tempDataDir();
  const failure = await runConfig(["set", "theme", "colourblind"], dataDir).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("Unknown theme \"colourblind\". Did you mean colorblind (Colorblind)?");
  const details = String((failure as { details?: unknown }).details);
  for (const id of getThemeIds()) expect(details).toContain(`${id} (`);
  expect(details).toContain("white (White Phosphor)");
  // Nothing was written.
  expect((await loadConfig(dataDir)).theme).toBe(DEFAULT_THEME);
});

test("config set theme saves the id for an id or a display name, and get reads it back with its name", async () => {
  const dataDir = await tempDataDir();
  expect(await runConfig(["set", "theme", "Solarized", "Light"], dataDir, true)).toMatchObject({ value: "solarized-light", dryRun: true });

  expect(await runConfig(["set", "theme", "colorblind"], dataDir)).toMatchObject({ value: "colorblind", name: "Colorblind" });
  expect(JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")).theme).toBe("colorblind");
  expect(await runConfig(["get", "theme"], dataDir)).toEqual({ key: "theme", value: "colorblind", name: "Colorblind" });
});

test("a saved theme this build does not know is kept for sync, and the app draws the default meanwhile", async () => {
  const dataDir = await tempDataDir();
  await writeFile(join(dataDir, "config.json"), JSON.stringify({ dataDir, theme: "from-a-newer-build" }), "utf-8");
  const config = await loadConfig(dataDir);
  expect(config.theme).toBe("from-a-newer-build");
  expect(getThemeColors(config.theme)).toEqual(getThemeColors(DEFAULT_THEME));
  expect(await runConfig(["get", "theme"], dataDir)).toEqual({ key: "theme", value: "from-a-newer-build", name: null });
});

test("config themes lists the registry, marking the color-blind, high contrast, default and current themes", async () => {
  const dataDir = await tempDataDir();
  await writeFile(join(dataDir, "config.json"), JSON.stringify({ dataDir, theme: "paper" }), "utf-8");
  const { context, printed } = createTestCliContext({ config: await loadConfig(dataDir), dataDir });
  await configCommand.execute(["themes"], context);
  const rows = printed[0]!.result.data as Array<Record<string, unknown>>;
  expect(rows.map((row) => row.id)).toEqual(getThemeIds());
  expect(rows.filter((row) => row.colorblindSafe).map((row) => row.id)).toEqual(["colorblind", "colorblind-light", "high-contrast"]);
  expect(rows.filter((row) => row.highContrast).map((row) => row.id)).toEqual(["high-contrast"]);
  expect(rows.find((row) => row.default)?.id).toBe(DEFAULT_THEME);
  expect(rows.find((row) => row.current)?.id).toBe("paper");
  expect(rows.find((row) => row.id === "colorblind-light")).toMatchObject({ name: "Colorblind Light", appearance: "light" });
});
