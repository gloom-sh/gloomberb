import { Fragment, createElement, type ReactNode } from "react";
import type {
  GloomPlugin,
  GloomPluginContext,
} from "../../types/plugin";
import { pluginContextInNamespace } from "../registry/plugin-state";
import { withPluginStateNamespace } from "../runtime/context";

type PluginMetadataKey =
  | "id"
  | "stateId"
  | "name"
  | "version"
  | "description"
  | "toggleable"
  | "order"
  | "targets"
  | "homepage"
  | "configSchema"
  | "isConfigured";
type PluginMetadata = Pick<GloomPlugin, PluginMetadataKey>;

// Brokers and declared hosts belong to external plugins; no built-in module contributes them.
export type PluginModule = Omit<GloomPlugin, PluginMetadataKey | "broker" | "hosts">;

/** A module with a say in how it is composed. A bare module takes the defaults. */
interface PluginModuleEntry {
  module: PluginModule;
  /**
   * The state namespace the module keeps when it sits in a plugin whose own
   * namespace is different: its panes, tabs and slots read pane, plugin and
   * config state there, and its setup gets persistence and caches there. Set
   * it when a module moves to another plugin so its users keep their state.
   */
  stateId?: string;
  /** Left out of the plugin the desktop backend process runs. */
  rendererOnly?: boolean;
}

type PluginModuleInput = PluginModule | PluginModuleEntry;

const HANDLED_MODULE_KEYS = [
  "cliCommands",
  "setup",
  "dispose",
  "panes",
  "paneTemplates",
  "capabilities",
  "slots",
] as const satisfies readonly (keyof PluginModule)[];

type MissingModuleKey = Exclude<keyof PluginModule, typeof HANDLED_MODULE_KEYS[number]>;
const ALL_MODULE_KEYS_HANDLED: MissingModuleKey extends never ? true : never = true;
void ALL_MODULE_KEYS_HANDLED;

interface CompositePluginOptions extends PluginMetadata {
  modules: readonly PluginModuleInput[];
}

function moduleEntry(input: PluginModuleInput): PluginModuleEntry {
  return "module" in input ? input : { module: input };
}

/**
 * The module as it runs under a namespace other than its plugin's: every
 * surface it renders and the context its setup receives are moved there,
 * while what it contributes still belongs to the plugin.
 */
function moduleInNamespace(module: PluginModule, stateId: string): PluginModule {
  const slots = module.slots && Object.fromEntries(Object.entries(module.slots).map(([slotName, renderer]) => [
    slotName,
    renderer && withPluginStateNamespace(stateId, renderer as (props: unknown) => ReactNode),
  ])) as PluginModule["slots"];
  return {
    ...module,
    ...(module.panes ? {
      panes: module.panes.map((pane) => ({ ...pane, component: withPluginStateNamespace(stateId, pane.component) })),
    } : {}),
    ...(slots ? { slots } : {}),
    ...(module.setup ? {
      setup: (ctx: GloomPluginContext) => {
        const scoped = pluginContextInNamespace(ctx, stateId);
        return module.setup!({
          ...scoped,
          registerPane: (pane) => ctx.registerPane({ ...pane, component: withPluginStateNamespace(stateId, pane.component) }),
          registerTickerResearchTab: (tab) => ctx.registerTickerResearchTab({
            ...tab,
            component: withPluginStateNamespace(stateId, tab.component),
          }),
        });
      },
    } : {}),
  };
}

function composeSlots(modules: readonly PluginModule[]): GloomPlugin["slots"] {
  const renderersBySlot = new Map<string, Array<(props: unknown) => ReactNode>>();

  for (const module of modules) {
    for (const [slotName, renderer] of Object.entries(module.slots ?? {})) {
      if (!renderer) continue;
      const renderers = renderersBySlot.get(slotName) ?? [];
      renderers.push(renderer as (props: unknown) => ReactNode);
      renderersBySlot.set(slotName, renderers);
    }
  }

  if (renderersBySlot.size === 0) return undefined;

  const slots: Record<string, (props: unknown) => ReactNode> = {};
  for (const [slotName, renderers] of renderersBySlot) {
    slots[slotName] = (props) => createElement(
      Fragment,
      null,
      ...renderers.map((render, index) => createElement(render, { ...(props as object), key: index })),
    );
  }

  return slots as GloomPlugin["slots"];
}

const compositions = new WeakMap<GloomPlugin, CompositePluginOptions>();
const backendVariants = new WeakMap<GloomPlugin, GloomPlugin>();

/**
 * Combines implementation modules under one real plugin identity.
 *
 * Modules deliberately have no identity or toggle metadata. Every contribution
 * is owned, enabled, and disposed through the returned parent plugin, and
 * persisted under its namespace unless the module's entry keeps another.
 */
export function composeBuiltinPlugin(options: CompositePluginOptions): GloomPlugin {
  const { modules: inputs, ...metadata } = options;
  const pluginStateId = metadata.stateId ?? metadata.id;
  const modules = inputs.map((input) => {
    const { module, stateId } = moduleEntry(input);
    return stateId && stateId !== pluginStateId ? moduleInNamespace(module, stateId) : module;
  });
  const cliCommands = modules.flatMap((module) => module.cliCommands ?? []);
  const panes = modules.flatMap((module) => module.panes ?? []);
  const paneTemplates = modules.flatMap((module) => module.paneTemplates ?? []);
  const capabilities = modules.flatMap((module) => module.capabilities ?? []);
  const slots = composeSlots(modules);
  let startedModules: PluginModule[] = [];

  const plugin: GloomPlugin = {
    ...metadata,
    ...(cliCommands.length > 0 ? { cliCommands } : {}),
    ...(panes.length > 0 ? { panes } : {}),
    ...(paneTemplates.length > 0 ? { paneTemplates } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(slots ? { slots } : {}),

    async setup(ctx: GloomPluginContext) {
      startedModules = [];
      for (const module of modules) {
        startedModules.push(module);
        try {
          await module.setup?.(ctx);
        } catch (error) {
          // Logged as the plugin, so the failure counts toward its health.
          ctx.log.error("Module setup failed", { error: error instanceof Error ? error.message : String(error) });
        }
      }
    },

    dispose() {
      let firstError: unknown;
      for (const module of startedModules.reverse()) {
        try {
          module.dispose?.();
        } catch (error) {
          firstError ??= error;
        }
      }
      startedModules = [];
      if (firstError) throw firstError;
    },
  };
  compositions.set(plugin, options);
  return plugin;
}

/**
 * The plugin as the desktop backend process runs it: the same identity
 * without its renderer-only modules. Anything else comes back unchanged.
 */
export function withoutRendererOnlyModules(plugin: GloomPlugin): GloomPlugin {
  const options = compositions.get(plugin);
  if (!options?.modules.some((input) => moduleEntry(input).rendererOnly)) return plugin;
  let variant = backendVariants.get(plugin);
  if (!variant) {
    variant = composeBuiltinPlugin({
      ...options,
      modules: options.modules.filter((input) => !moduleEntry(input).rendererOnly),
    });
    backendVariants.set(plugin, variant);
  }
  return variant;
}
