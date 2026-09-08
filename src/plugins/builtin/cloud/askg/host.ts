import type { AppPersistence } from "../../../../data/app-persistence";
import type { TickerRepository } from "../../../../data/ticker-repository";
import type { AssetDataRouter } from "../../../../sources/provider-router";
import type { MarketContext } from "../../../../cli/types";
import type { AppConfig } from "../../../../types/config";
import { getSharedRegistry } from "../../../registry";
import type { PluginRegistry } from "../../../registry";
import { createASKGToolExecutor, type ASKGToolExecutor } from "./executor";
import { buildASKGClientManifest, type ASKGClientManifest } from "./manifest";
import type { InProcessRemoteControlHandler } from "./undo";

/**
 * Headless loaders only read `config` and `dataProvider`, and the persisted
 * cloud session only reads plugin state, so the registry's runtime ports carry
 * everything a delegated tool needs. The casts stay here rather than widening
 * the executor's contract for one renderer.
 */
function marketContextFromRegistry(registry: PluginRegistry, config: AppConfig): MarketContext {
  return {
    config,
    dataDir: config.dataDir,
    persistence: registry.persistence as unknown as AppPersistence,
    store: registry.tickerRepository as unknown as TickerRepository,
    dataProvider: registry.marketData as unknown as AssetDataRouter,
  };
}

let manifestCache: { registry: PluginRegistry; manifest: Promise<ASKGClientManifest> } | null = null;

/** The tools this client advertises, rebuilt when the registry changes. */
export function loadASKGClientManifest(): Promise<ASKGClientManifest> {
  const registry = getSharedRegistry();
  if (!registry) return Promise.reject(new Error("The plugin registry is not available."));
  if (manifestCache?.registry === registry) return manifestCache.manifest;
  const manifest = buildASKGClientManifest(registry);
  manifestCache = { registry, manifest };
  return manifest;
}

export function resetASKGClientManifestCache(): void {
  manifestCache = null;
}

export interface ASKGToolExecutorOptions {
  config: AppConfig;
  remoteHandler: InProcessRemoteControlHandler;
  manifest: ASKGClientManifest;
}

export function createASKGRendererToolExecutor({
  config,
  remoteHandler,
  manifest,
}: ASKGToolExecutorOptions): ASKGToolExecutor | null {
  const registry = getSharedRegistry();
  if (!registry) return null;
  return createASKGToolExecutor({
    manifests: manifest.tools,
    registry,
    context: marketContextFromRegistry(registry, config),
    remoteHandler,
  });
}

export interface ASKGPaneTarget {
  templateId?: string;
  paneId: string;
  label: string;
}

/**
 * Reverses the manifest's naming so a timeline row can open the pane the tool
 * read from. Tool names come from a template shortcut prefix or a pane id,
 * lowercased, which is what `buildASKGToolManifests` advertised.
 */
export function resolveToolPaneTarget(toolName: string): ASKGPaneTarget | null {
  const registry = getSharedRegistry();
  if (!registry) return null;
  const normalized = toolName.toLowerCase();
  for (const template of registry.paneTemplates.values()) {
    const token = (template.shortcut?.prefix ?? template.id).toLowerCase();
    if (token !== normalized) continue;
    return { templateId: template.id, paneId: template.paneId, label: template.label };
  }
  const pane = registry.panes.get(toolName);
  return pane ? { paneId: pane.id, label: pane.name } : null;
}
