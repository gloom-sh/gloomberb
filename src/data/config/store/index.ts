import type { AppConfig } from "../../../types/config";

export { sanitizeLayout } from "../layout";

/** Another program's change to config.json, to fold into this program's copy. */
export interface ExternalConfigChange {
  /** `config` with the change folded in, or the same object when it already holds it. */
  apply(config: AppConfig): AppConfig;
}

export interface ConfigStoreHost {
  getDataDir(): Promise<string | null>;
  loadConfig(dataDir: string): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;
  initDataDir(dataDir: string): Promise<AppConfig>;
  resetAllData(dataDir: string): Promise<void>;
  exportConfig(config: AppConfig, destPath: string): Promise<void>;
  importConfig(dataDir: string, srcPath: string): Promise<AppConfig>;
  /**
   * Reports each change another program makes to the config while this one
   * runs (a `gloom` command run beside the app). A host whose config no other
   * program writes leaves it out.
   */
  watchExternalChanges?(dataDir: string, listener: (change: ExternalConfigChange) => void): () => void;
}

let configuredHost: ConfigStoreHost | null = null;
let nodeHostPromise: Promise<ConfigStoreHost> | null = null;

export function setConfigStoreHost(host: ConfigStoreHost | null): void {
  configuredHost = host;
}

async function loadNodeHost(): Promise<ConfigStoreHost> {
  if (!nodeHostPromise) {
    nodeHostPromise = import("./node") as Promise<ConfigStoreHost>;
  }
  return nodeHostPromise;
}

async function getHost(): Promise<ConfigStoreHost> {
  if (configuredHost) return configuredHost;
  if (typeof Bun === "undefined") {
    throw new Error("Config store host is not configured for this renderer.");
  }
  return loadNodeHost();
}

export async function getDataDir(): Promise<string | null> {
  return (await getHost()).getDataDir();
}

export async function loadConfig(dataDir: string): Promise<AppConfig> {
  return (await getHost()).loadConfig(dataDir);
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return (await getHost()).saveConfig(config);
}

export async function initDataDir(dataDir: string): Promise<AppConfig> {
  return (await getHost()).initDataDir(dataDir);
}

export async function resetAllData(dataDir: string): Promise<void> {
  return (await getHost()).resetAllData(dataDir);
}

export async function exportConfig(config: AppConfig, destPath: string): Promise<void> {
  return (await getHost()).exportConfig(config, destPath);
}

export async function importConfig(dataDir: string, srcPath: string): Promise<AppConfig> {
  return (await getHost()).importConfig(dataDir, srcPath);
}

/**
 * Calls `listener` with each change another program makes to the config of
 * `dataDir` while this one runs. The listener folds it into the app's state
 * at once: saves already waiting are written with it.
 */
export function watchExternalConfigChanges(dataDir: string, listener: (change: ExternalConfigChange) => void): () => void {
  let stop: (() => void) | null = null;
  let stopped = false;
  void getHost().then((host) => {
    if (stopped || !host.watchExternalChanges) return;
    stop = host.watchExternalChanges(dataDir, listener);
  }, () => { /* Intentional ignore: a renderer without a config store has no file to watch. */ });
  return () => {
    stopped = true;
    stop?.();
    stop = null;
  };
}
