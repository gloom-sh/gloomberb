import type { AppPersistence } from "../../../../data/app-persistence";
import type { TickerRepository } from "../../../../data/ticker-repository";
import type { AssetDataRouter } from "../../../../sources/provider-router";
import type { MarketContext } from "../../../../cli/types";
import type { AppConfig } from "../../../../types/config";
import type { PaneFunctionCatalog } from "../../../../cli/pane-functions/catalog";
import { resolvePaneFunction } from "../../../../cli/pane-functions/resolver";
import { capabilityPluginState } from "../../../../cli/pane-functions/capabilities";
import { optionPaneState } from "../../../../cli/pane-functions/options";
import { getSharedRegistry } from "../../../registry";
import type { PluginRegistry } from "../../../registry";
import { createASKGToolExecutor, type ASKGToolExecutor } from "./executor";
import { buildASKGClientManifest, type ASKGClientManifest } from "./manifest";
import { buildPaneSharePayload } from "../../../../shares/pane";
import { parseSharePayload, type SharePayload } from "../../../../shares/payload";
import { formatSourceCommand, type ASKGSourceCommand } from "./sources";
import type { ASKGUndoManager, InProcessRemoteControlHandler } from "./undo";

/**
 * Headless loaders only read `config` and `dataProvider`, and the persisted
 * cloud session only reads plugin state, so the registry's runtime ports carry
 * everything a delegated tool needs. The casts stay here rather than widening
 * the executor's contract for one renderer.
 */
export function marketContextFromRegistry(registry: PluginRegistry, config: AppConfig): MarketContext {
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
  /**
   * Keeps the undo tokens. A token only undoes through the manager that
   * issued it, so it must outlive the executor that ran the call.
   */
  undoManager?: ASKGUndoManager;
}

export function createASKGRendererToolExecutor({
  config,
  remoteHandler,
  manifest,
  undoManager,
}: ASKGToolExecutorOptions): ASKGToolExecutor | null {
  const registry = getSharedRegistry();
  if (!registry) return null;
  return createASKGToolExecutor({
    manifests: manifest.tools,
    registry,
    context: marketContextFromRegistry(registry, config),
    remoteHandler,
    ...(undoManager ? { undoManager } : {}),
  });
}

export interface ASKGPaneTarget {
  templateId?: string;
  paneId: string;
  label: string;
}

/** A pane share: what Share puts behind a link, and what opens one. */
export type ASKGSourceShare = Extract<SharePayload, { kind: "pane" }>;

/**
 * The pane share a source opens, built here, not stored: the pane `fn` and
 * `shot` resolve the same words to, with the settings and view state its
 * options set (FA's period), as the tool call that read the figure ran. It
 * opens the way a share link does, and becomes one (`createShare`) only when
 * the answer is shared. Its title is the words, as its chip says them, so a
 * link made of it reads the same in chat. Throws what `fn` would say when the
 * app cannot open it.
 */
export async function buildASKGSourceShare(
  source: ASKGSourceCommand,
  config: AppConfig,
): Promise<ASKGSourceShare> {
  const registry = getSharedRegistry();
  if (!registry) throw new Error("The plugin registry is not available.");
  return sourceShare(registry, marketContextFromRegistry(registry, config), source);
}

/** `buildASKGSourceShare` from the functions and the market context it is given. */
export async function sourceShare(
  catalog: PaneFunctionCatalog,
  context: MarketContext,
  source: ASKGSourceCommand,
): Promise<ASKGSourceShare> {
  const resolved = await resolvePaneFunction(catalog, context, {
    target: source.code,
    arg: source.arg,
    options: source.options,
    outputPath: null,
    width: 1280,
    height: 720,
    theme: null,
    scale: 1,
    watermark: null,
    requireBotSafe: false,
  }, { strictHeadlessOptions: true });
  const pluginState = capabilityPluginState(resolved.capability, resolved.options);
  const paneState = {
    ...optionPaneState(resolved.options),
    ...(Object.keys(pluginState).length > 0 ? { pluginState } : {}),
  };
  const share = buildPaneSharePayload(catalog, resolved.instance, paneState);
  if (!share) throw new Error("This pane has no view to open.");
  const titled = parseSharePayload({ ...share, data: { ...share.data, title: formatSourceCommand(source) } });
  return titled?.kind === "pane" ? titled : share;
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
