import type { DataProvider } from "../../types/data-provider";
import type { PluginRegistry } from "./index";

let sharedMarketData: DataProvider | undefined;
let sharedRegistry: PluginRegistry | undefined;

export function getSharedMarketData(): DataProvider | undefined { return sharedMarketData; }
export function getSharedRegistry(): PluginRegistry | undefined { return sharedRegistry; }

export function setSharedMarketDataForTests(provider: DataProvider | undefined): void {
  sharedMarketData = provider;
}

export function setSharedRegistryForTests(registry: PluginRegistry | undefined): void {
  sharedRegistry = registry;
}

export function bindSharedRegistry(registry: PluginRegistry, marketData: DataProvider): void {
  sharedMarketData = marketData;
  sharedRegistry = registry;
  (globalThis as any).__gloomRegistry = registry;
}

export function releaseSharedRegistry(registry: PluginRegistry, marketData: DataProvider): void {
  if (sharedRegistry === registry) {
    sharedRegistry = undefined;
    if (sharedMarketData === marketData) sharedMarketData = undefined;
  }
  if ((globalThis as any).__gloomRegistry === registry) {
    delete (globalThis as any).__gloomRegistry;
  }
}
