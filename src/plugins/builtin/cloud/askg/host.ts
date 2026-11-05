import type { AppPersistence } from "../../../../data/app-persistence";
import type { TickerRepository } from "../../../../data/ticker-repository";
import type { AssetDataRouter } from "../../../../sources/provider-router";
import type { MarketContext } from "../../../../cli/types";
import type { AppConfig } from "../../../../types/config";
import type { PaneTemplateCreateOptions } from "../../../../types/plugin";
import { resolvePaneFunction } from "../../../../cli/pane-functions/resolver";
import { capabilityPluginState } from "../../../../cli/pane-functions/capabilities";
import { optionPaneState } from "../../../../cli/pane-functions/options";
import { getSharedRegistry } from "../../../registry";
import type { PluginRegistry } from "../../../registry";
import { createASKGToolExecutor, type ASKGToolExecutor } from "./executor";
import { buildASKGClientManifest, type ASKGClientManifest } from "./manifest";
import type { ASKGSourceCommand } from "./sources";
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

/** How a source opens: its function's template with the run's options, or a pane that has no template. */
export type ASKGSourceOpening =
  | { kind: "template"; templateId: string; options: PaneTemplateCreateOptions }
  | { kind: "pane"; paneId: string };

/**
 * Resolves a source the way `fn` and `shot` resolve the same words, and as
 * the tool call that read it did, so the pane opens on the view the figure was
 * read from: the template, its argument, and the settings its options set.
 * Throws what `fn` would say when the app cannot open it.
 */
export async function resolveASKGSourceOpening(
  source: ASKGSourceCommand,
  config: AppConfig,
): Promise<ASKGSourceOpening> {
  const registry = getSharedRegistry();
  if (!registry) throw new Error("The plugin registry is not available.");
  const resolved = await resolvePaneFunction(registry, marketContextFromRegistry(registry, config), {
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
  if (!resolved.template) return { kind: "pane", paneId: resolved.pane.id };
  if (Object.keys(source.options).length === 0) {
    return { kind: "template", templateId: resolved.template.id, options: { ...resolved.createOptions } };
  }
  // As `shot` draws it: the settings the options set, and the view state a
  // pane keeps some of them in (FA's period, a tab).
  const pluginState = capabilityPluginState(resolved.capability, resolved.options);
  const paneState = {
    ...optionPaneState(resolved.options),
    ...(Object.keys(pluginState).length > 0 ? { pluginState } : {}),
  };
  return {
    kind: "template",
    templateId: resolved.template.id,
    options: {
      ...resolved.createOptions,
      settings: resolved.instance.settings ?? {},
      ...(Object.keys(paneState).length > 0 ? { paneState } : {}),
    },
  };
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
