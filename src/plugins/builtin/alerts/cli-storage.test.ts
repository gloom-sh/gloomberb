import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../../data/config/store";
import { serializeCliResult } from "../../../cli/result";
import { createTestCliContext } from "../../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import { createAlert } from "./alert-engine";
import { alertsCliCommand } from "./cli";
import { createEventAlert } from "./events";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(raw: unknown) {
  const parent = join(homedir(), ".cache/gloom-smoke/alerts-storage-tests");
  await mkdir(parent, { recursive: true });
  const dataDir = await mkdtemp(join(parent, "profile-"));
  dirs.push(dataDir);
  const config = createDefaultConfig(dataDir);
  const event = { ...createEventAlert("congress-watched", ""), status: "paused" as const };
  config.pluginConfig.alerts = { alerts: raw, eventAlerts: JSON.stringify([event]) };
  await saveConfig(config);
  const provider = createTestDataProvider({
    getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: createTestQuote({ symbol: target.symbol }) })),
  });
  return { config, dataDir, event, provider };
}

test("CLI mutations never overwrite unreadable price data, including dry runs and partially readable lists", async () => {
  const old = { ...createAlert("AAPL", "above", 200), id: "old" };
  for (const raw of ["[{broken", JSON.stringify([old, null]), { unexpected: true }]) {
    const { config, dataDir, provider } = await fixture(raw);
    const before = await readFile(join(dataDir, "config.json"));
    for (const args of [["add", "AAPL", "above", "200"], ["delete", "old"], ["rearm", "old"]]) {
      for (const dryRun of [false, true]) {
        const cli = createTestCliContext({ config, dataProvider: provider }, { dryRun });
        await expect(alertsCliCommand.execute(args, cli.context)).rejects.toThrow("Saved price alerts");
        expect(cli.printed).toEqual([]);
        expect(await readFile(join(dataDir, "config.json"))).toEqual(before);
      }
    }
  }
});

test("CLI list exposes the read failure in text and JSON while healthy event rules stay usable", async () => {
  const raw = "[{broken";
  const { config, dataDir, event, provider } = await fixture(raw);
  for (const format of ["text", "json"] as const) {
    const cli = createTestCliContext({ config, dataProvider: provider }, { format });
    await alertsCliCommand.execute(["list"], cli.context);
    const printed = cli.printed[0]!;
    const output = serializeCliResult(printed.result, cli.context.cliOptions, printed.options);
    expect(printed.result.warnings).toEqual([expect.stringContaining("Saved price alerts could not be read")]);
    if (format === "json") expect(JSON.parse(output).warnings).toEqual(printed.result.warnings);
  }
  for (const action of ["rearm", "delete"]) {
    const current = await loadConfig(dataDir);
    const cli = createTestCliContext({ config: current, dataProvider: provider });
    await alertsCliCommand.execute([action, event.id], cli.context);
    expect(cli.printed[0]!.result.data.changed).toBe(true);
    expect((await loadConfig(dataDir)).pluginConfig.alerts!.alerts).toBe(raw);
  }
});

test("alerts remove deletes as delete does, and without an ID names the form to type", async () => {
  const { config, dataDir, provider } = await fixture("[]");
  await alertsCliCommand.execute(["add", "AAPL", "above", "200"], createTestCliContext({ config, dataProvider: provider }).context);
  const saved = await loadConfig(dataDir);
  const [price] = JSON.parse(saved.pluginConfig.alerts!.alerts as string);
  const remove = createTestCliContext({ config: saved, dataProvider: provider });
  // Before: the bare usage, list|add|delete|rearm, whatever followed.
  await expect(alertsCliCommand.execute(["remove"], remove.context)).rejects.toThrow("Usage: gloom alerts delete <id>");
  await alertsCliCommand.execute(["remove", price.id], remove.context);
  expect(remove.printed[0]!.result.data).toMatchObject({ changed: true, id: price.id });
  expect((await loadConfig(dataDir)).pluginConfig.alerts!.alerts).toBe("[]");
});

test("corrupt metric storage leaves price additions and deletions usable and is kept byte for byte", async () => {
  const { config, dataDir, provider } = await fixture("[]");
  const broken = "[{broken";
  config.pluginConfig.alerts!.metricAlerts = broken;
  await saveConfig(config);
  const add = createTestCliContext({ config, dataProvider: provider });
  await alertsCliCommand.execute(["add", "AAPL", "above", "200"], add.context);
  const current = await loadConfig(dataDir);
  expect(current.pluginConfig.alerts!.metricAlerts).toBe(broken);
  const [price] = JSON.parse(current.pluginConfig.alerts!.alerts as string);
  expect(price.symbol).toBe("AAPL");
  const remove = createTestCliContext({ config: current, dataProvider: provider });
  await alertsCliCommand.execute(["delete", price.id], remove.context);
  const after = await loadConfig(dataDir);
  expect(after.pluginConfig.alerts!.alerts).toBe("[]");
  expect(after.pluginConfig.alerts!.metricAlerts).toBe(broken);
});
