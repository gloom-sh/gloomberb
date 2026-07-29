import { describe, expect, test } from "bun:test";
import type { CliCommandContext } from "../types/plugin";
import type { CliServicesContext, ConfigContext, MarketContext } from "./types";
import {
  ensureCliServicesReady,
  withCliServices,
  withConfigData,
  withMarketData,
} from "./context";

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
