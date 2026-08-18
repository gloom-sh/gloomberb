import { PRESERVED_PASSWORD_HINT } from "../../brokers/profile-form";
import type { BrokerAdapter } from "../../types/broker";
import type { BrokerInstanceConfig } from "../../types/config";
import type { GloomPlugin } from "../../types/plugin";
import type { BrokerPortfolioSnapshot } from "./normalize";
import { loadSimpleFinNativeModule } from "./native-loader";

async function loadSimpleFinPortfolio(instance: BrokerInstanceConfig): Promise<BrokerPortfolioSnapshot> {
  const module = await loadSimpleFinNativeModule();
  return module.loadSimpleFinPortfolio(instance);
}

export const simpleFinBroker: BrokerAdapter = {
  id: "simplefin",
  name: "SimpleFIN",
  configSchema: [{
    key: "setupToken",
    label: "Setup Token",
    type: "password",
    required: true,
    placeholder: "One-time token from SimpleFIN Bridge",
  }],

  async validate(instance) {
    return [instance.config.setupToken, instance.config.accessUrl]
      .some((value) => typeof value === "string" && value.trim().length > 0);
  },

  async importPositions(instance) {
    return (await loadSimpleFinPortfolio(instance)).positions;
  },

  async importPortfolioSnapshot(instance) {
    return loadSimpleFinPortfolio(instance);
  },

  async listAccounts(instance) {
    return (await loadSimpleFinPortfolio(instance)).accounts;
  },

  async getPersistedConfigUpdate(instance) {
    const module = await loadSimpleFinNativeModule();
    return module.simpleFinBroker.getPersistedConfigUpdate?.(instance) ?? null;
  },

  toConfigValues(instance) {
    return {
      setupToken: typeof instance.config.accessUrl === "string"
        ? PRESERVED_PASSWORD_HINT
        : instance.config.setupToken,
    };
  },

  fromConfigValues(values, previous) {
    const setupToken = typeof values.setupToken === "string" ? values.setupToken.trim() : "";
    const accessUrl = previous && typeof previous.config.accessUrl === "string" ? previous.config.accessUrl : "";
    if (setupToken === PRESERVED_PASSWORD_HINT && accessUrl) return { setupToken: "", accessUrl };
    if (setupToken) return { setupToken };
    return accessUrl ? { setupToken: "", accessUrl } : { setupToken: "" };
  },
};

export const simpleFinPlugin: GloomPlugin = {
  id: "simplefin",
  name: "SimpleFIN",
  version: "1.0.0",
  description: "Read-only investment position sync through SimpleFIN Bridge.",
  toggleable: true,
  broker: simpleFinBroker,
};
