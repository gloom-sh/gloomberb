import { expect, test } from "bun:test";
import type { BrokerAdapter } from "../types/broker";
import type { BrokerInstanceConfig } from "../types/config";
import { buildBrokerDirectory } from "./directory";
import { brokerDirectoryLogo, brokerPortfolioLogo, brokerProfileLogo } from "./logos";
import { signedInBrokerAdapter } from "./signed-in/adapter";

const IBKR_PLUGIN = "data:image/svg+xml,ibkr-plugin";
const pluginLogo = (type: string) => (type === "ibkr" ? IBKR_PLUGIN : null);
const deviceIbkr = { id: "ibkr", name: "Interactive Brokers", configSchema: [{ key: "token", label: "Token", type: "text" }] } as BrokerAdapter;
const signedIn = (broker: string): BrokerInstanceConfig => ({
  id: `signed-in-${broker}`,
  brokerType: "signed-in",
  label: broker,
  connectionMode: broker,
  config: { broker },
} as BrokerInstanceConfig);

test("a broker's plugin icon wins, Gloom's own marks a broker it signs in to, and the rest get none", () => {
  const directory = buildBrokerDirectory({
    signedIn: [
      { id: "ibkr", name: "Interactive Brokers" },
      { id: "robinhood", name: "Robinhood" },
      { id: "tradier", name: "Tradier" },
    ] as never,
    adapters: [signedInBrokerAdapter, deviceIbkr],
  });
  const logo = (key: string) => brokerDirectoryLogo(directory.find((entry) => entry.key === key)!, pluginLogo);
  expect(logo("ibkr")).toBe(IBKR_PLUGIN);
  expect(logo("robinhood")).toStartWith("data:image/svg+xml,");
  expect(logo("tradier")).toBeNull();

  // A signed-in profile is listed with the broker it connects, not the adapter's owner.
  expect(brokerProfileLogo(signedIn("robinhood"), signedInBrokerAdapter, pluginLogo)).toBe(logo("robinhood"));
  expect(brokerProfileLogo(signedIn("tradier"), signedInBrokerAdapter, pluginLogo)).toBeNull();
});

test("a portfolio tab names the broker its initial stands for, and a manual one gets no mark", () => {
  const instances = [signedIn("robinhood")];
  const getAdapter = (type: string) => (type === "signed-in" ? signedInBrokerAdapter : null);
  expect(brokerPortfolioLogo({ brokerInstanceId: "signed-in-robinhood" }, instances, getAdapter, pluginLogo)?.src)
    .toStartWith("data:image/svg+xml,");
  expect(brokerPortfolioLogo({ brokerInstanceId: "gone", brokerId: "tradier" }, instances, getAdapter, pluginLogo))
    .toEqual({ src: null, name: "tradier" });
  expect(brokerPortfolioLogo({}, instances, getAdapter, pluginLogo)).toBeNull();
});
