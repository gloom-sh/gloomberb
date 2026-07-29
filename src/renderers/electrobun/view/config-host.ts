import { setConfigStoreHost, type ConfigStoreHost } from "../../../data/config/store";
import type { AppConfig } from "../../../types/config";
import { backendRequest, getElectrobunBackendInitSnapshot } from "./backend-rpc";

const electrobunConfigStoreHost: ConfigStoreHost = {
  async getDataDir() {
    return getElectrobunBackendInitSnapshot()?.config.dataDir ?? null;
  },
  async loadConfig() {
    const config = getElectrobunBackendInitSnapshot()?.config;
    if (!config) throw new Error("Electrobun backend has not initialized config.");
    return config;
  },
  async saveConfig(config: AppConfig) {
    await backendRequest("config.save", { config });
  },
  async initDataDir() {
    const config = getElectrobunBackendInitSnapshot()?.config;
    if (!config) throw new Error("Electrobun backend has not initialized config.");
    return config;
  },
  async resetAllData(dataDir: string) {
    await backendRequest("config.resetAllData", { dataDir });
  },
  async exportConfig(config: AppConfig, destPath: string) {
    await backendRequest("config.export", { config, destPath });
  },
  async importConfig(dataDir: string, srcPath: string) {
    return backendRequest("config.import", { dataDir, srcPath });
  },
};

export function installElectrobunConfigStoreHost(): void {
  setConfigStoreHost(electrobunConfigStoreHost);
}
