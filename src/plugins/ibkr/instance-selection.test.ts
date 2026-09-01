import { describe, expect, test } from "bun:test";
import { cloneLayout, CURRENT_CONFIG_VERSION, DEFAULT_LAYOUT, type AppConfig, type BrokerInstanceConfig } from "../../types/config";
import { resolveIbkrTradingInstanceId, getLockedIbkrTradingInstanceId } from "./instance-selection";

function createIbkrInstance(
  id: string,
  label: string,
  connectionMode: "flex" | "gateway",
  config: Record<string, unknown>,
): BrokerInstanceConfig {
  return {
    id,
    brokerType: "ibkr",
    label,
    connectionMode,
    config: { connectionMode, ...config },
    enabled: true,
  };
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: "",
    configVersion: CURRENT_CONFIG_VERSION,
    baseCurrency: "USD",
    refreshIntervalMinutes: 30,
    portfolios: [],
    watchlists: [],
    layout: cloneLayout(DEFAULT_LAYOUT),
    layouts: [{ name: "Default", layout: cloneLayout(DEFAULT_LAYOUT) }],
    activeLayoutIndex: 0,
    brokerInstances: [],
    disabledPlugins: [],
    disabledSources: [],
    pluginConfig: {},
    theme: "amber",
    chartPreferences: {
      renderer: "auto",
    },
    recentTickers: [],
    ...overrides,
  };
}

describe("IBKR trading instance selection", () => {
  test("returns no trading instance when only flex profiles exist", () => {
    const config = createConfig({
      brokerInstances: [
        createIbkrInstance("ibkr-default", "IBKR", "flex", {
          flex: { token: "token", queryId: "query" },
        }),
      ],
    });

    expect(resolveIbkrTradingInstanceId(config, "", "ibkr-default")).toBeUndefined();
  });

  test("prefers a gateway profile over a flex profile when both exist", () => {
    const config = createConfig({
      brokerInstances: [
        createIbkrInstance("ibkr-default", "IBKR", "flex", {
          flex: { token: "token", queryId: "query" },
        }),
        createIbkrInstance("ibkr-paper", "Paper", "gateway", {
          gateway: { host: "127.0.0.1", port: 4002, clientId: 1 },
        }),
      ],
    });

    expect(resolveIbkrTradingInstanceId(config, "", "ibkr-default")).toBe("ibkr-paper");
  });

  test("does not lock trading to a flex-backed portfolio", () => {
    const config = createConfig({
      portfolios: [{
        id: "broker:ibkr-default:DU12345",
        name: "DU12345",
        currency: "USD",
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-default",
        brokerAccountId: "DU12345",
      }],
      brokerInstances: [
        createIbkrInstance("ibkr-default", "IBKR", "flex", {
          flex: { token: "token", queryId: "query" },
        }),
        createIbkrInstance("ibkr-paper", "Paper", "gateway", {
          gateway: { host: "127.0.0.1", port: 4002, clientId: 1 },
        }),
      ],
    });

    expect(getLockedIbkrTradingInstanceId(config, "broker:ibkr-default:DU12345")).toBeUndefined();
    expect(resolveIbkrTradingInstanceId(config, "broker:ibkr-default:DU12345")).toBe("ibkr-paper");
  });

  test("keeps trading locked to the active gateway-backed portfolio", () => {
    const config = createConfig({
      portfolios: [{
        id: "broker:ibkr-paper:DU12345",
        name: "DU12345",
        currency: "USD",
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-paper",
        brokerAccountId: "DU12345",
      }],
      brokerInstances: [
        createIbkrInstance("ibkr-paper", "Paper", "gateway", {
          gateway: { host: "127.0.0.1", port: 4002, clientId: 1 },
        }),
        createIbkrInstance("ibkr-live", "Live", "gateway", {
          gateway: { host: "127.0.0.1", port: 4001, clientId: 2 },
        }),
      ],
    });

    expect(getLockedIbkrTradingInstanceId(config, "broker:ibkr-paper:DU12345")).toBe("ibkr-paper");
    expect(resolveIbkrTradingInstanceId(config, "broker:ibkr-paper:DU12345", "ibkr-live")).toBe("ibkr-paper");
  });
});
