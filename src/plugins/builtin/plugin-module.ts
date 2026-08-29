import { Fragment, createElement, type ReactNode } from "react";
import type {
  GloomPlugin,
  GloomPluginContext,
} from "../../types/plugin";

type PluginMetadataKey = "id" | "name" | "version" | "description" | "toggleable" | "order";
type PluginMetadata = Pick<GloomPlugin, PluginMetadataKey>;

export type PluginModule = Omit<GloomPlugin, PluginMetadataKey>;

const HANDLED_MODULE_KEYS = [
  "cliCommands",
  "setup",
  "dispose",
  "panes",
  "paneTemplates",
  "broker",
  "capabilities",
  "slots",
] as const satisfies readonly (keyof PluginModule)[];

type MissingModuleKey = Exclude<keyof PluginModule, typeof HANDLED_MODULE_KEYS[number]>;
const ALL_MODULE_KEYS_HANDLED: MissingModuleKey extends never ? true : never = true;
void ALL_MODULE_KEYS_HANDLED;

interface CompositePluginOptions extends PluginMetadata {
  modules: readonly PluginModule[];
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
      ...renderers.map((render, index) => createElement(
        Fragment,
        { key: index },
        render(props),
      )),
    );
  }

  return slots as GloomPlugin["slots"];
}

/**
 * Combines implementation modules under one real plugin identity.
 *
 * Modules deliberately have no identity or toggle metadata. Every contribution
 * is owned, persisted, enabled, and disposed through the returned parent plugin.
 */
export function composeBuiltinPlugin(options: CompositePluginOptions): GloomPlugin {
  const { modules, ...metadata } = options;
  const cliCommands = modules.flatMap((module) => module.cliCommands ?? []);
  const panes = modules.flatMap((module) => module.panes ?? []);
  const paneTemplates = modules.flatMap((module) => module.paneTemplates ?? []);
  const capabilities = modules.flatMap((module) => module.capabilities ?? []);
  const brokers = modules.flatMap((module) => module.broker ? [module.broker] : []);
  const slots = composeSlots(modules);
  let startedModules: PluginModule[] = [];

  return {
    ...metadata,
    ...(cliCommands.length > 0 ? { cliCommands } : {}),
    ...(panes.length > 0 ? { panes } : {}),
    ...(paneTemplates.length > 0 ? { paneTemplates } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(slots ? { slots } : {}),

    async setup(ctx: GloomPluginContext) {
      startedModules = [];
      for (const broker of brokers) {
        ctx.registerBroker(broker);
      }
      for (const module of modules) {
        startedModules.push(module);
        try {
          await module.setup?.(ctx);
        } catch (error) {
          console.error(`[plugins] Module setup failed in plugin "${metadata.id}":`, error);
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
}
