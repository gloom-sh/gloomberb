import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDataDir, loadConfig, saveConfig } from "../data/config/store";
import type { CliCommandContext } from "../types/plugin";
import type { CliServicesContext, ConfigContext, MarketContext } from "./types";
import {
  ensureCliServicesReady,
  initConfigData,
  withCliServices,
  withConfigData,
  withMarketData,
} from "./context";

const originalGloomberbHome = process.env.GLOOMBERB_HOME;
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalGloomberbHome === undefined) delete process.env.GLOOMBERB_HOME;
  else process.env.GLOOMBERB_HOME = originalGloomberbHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A profile folder nothing has created yet, as on a machine that never ran Gloomberb. */
async function freshProfile(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "gloomberb-cli-context-"));
  tempDirs.push(parent);
  return join(parent, "profile");
}

/** config.json as written, without the folder it names, so two profiles compare. */
async function savedSettings(home: string): Promise<Record<string, unknown>> {
  const { dataDir: _dataDir, ...rest } = JSON.parse(await readFile(join(home, "config.json"), "utf-8"));
  return rest;
}

describe("CLI data folder on a new profile", () => {
  test("the first command creates it as the app's first launch does, leaving onboarding to the app", async () => {
    const home = await freshProfile();
    process.env.GLOOMBERB_HOME = home;

    const context = await initConfigData();
    context.persistence.close();
    expect(context.dataDir).toBe(home);
    expect(existsSync(join(home, ".gloomberb-cache.db"))).toBe(true);
    // The app opens onboarding when its config does not say it finished.
    expect(context.config.onboardingComplete).toBeUndefined();

    const appHome = await freshProfile();
    await mkdir(appHome, { recursive: true });
    await initDataDir(appHome);
    expect(await savedSettings(home)).toEqual(await savedSettings(appHome));

    // Later commands read that config instead of writing defaults over it.
    await saveConfig({ ...(await loadConfig(home)), theme: "paper" });
    const again = await initConfigData();
    again.persistence.close();
    expect(again.config.theme).toBe("paper");
  });

  test("a config.json it cannot read is left alone rather than reset to defaults", async () => {
    const home = await freshProfile();
    process.env.GLOOMBERB_HOME = home;
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), "{ \"theme\": ", "utf-8");

    await expect(initConfigData()).rejects.toThrow(`Could not read ${join(home, "config.json")}.`);
    expect(await readFile(join(home, "config.json"), "utf-8")).toBe("{ \"theme\": ");
  });
});

function initializer<K extends "initConfigData" | "initMarketData" | "initServices", T>(
  key: K,
  value: T,
): Pick<CliCommandContext, K> {
  return { [key]: async () => value } as Pick<CliCommandContext, K>;
}

describe("CLI scoped contexts", () => {
  test("closes config and market persistence after successful operations", async () => {
    let configCloses = 0;
    let marketCloses = 0;
    const config = { persistence: { close: () => configCloses++ } } as unknown as ConfigContext;
    const market = { persistence: { close: () => marketCloses++ } } as unknown as MarketContext;

    expect(await withConfigData(initializer("initConfigData", config), async () => "config"))
      .toBe("config");
    expect(await withMarketData(initializer("initMarketData", market), async () => "market"))
      .toBe("market");
    expect(configCloses).toBe(1);
    expect(marketCloses).toBe(1);
  });

  test("destroys services when an operation throws", async () => {
    let destroys = 0;
    const services = { destroy: () => destroys++ } as unknown as CliServicesContext;

    await expect(withCliServices(initializer("initServices", services), async () => {
      throw new Error("operation failed");
    })).rejects.toThrow("operation failed");
    expect(destroys).toBe(1);
  });

  test("accepts an injected market initializer and closes it when an operation throws", async () => {
    let closes = 0;
    const market = { persistence: { close: () => closes++ } } as unknown as MarketContext;

    await expect(withMarketData(async () => market, async () => {
      throw new Error("market operation failed");
    })).rejects.toThrow("market operation failed");
    expect(closes).toBe(1);
  });

  test("destroys partially initialized services when plugin setup rejects", async () => {
    let destroys = 0;
    const services = {
      ready: Promise.reject(new Error("plugin setup failed")),
      destroy: () => destroys++,
    };

    await expect(ensureCliServicesReady(services)).rejects.toThrow("plugin setup failed");
    expect(destroys).toBe(1);
  });
});
