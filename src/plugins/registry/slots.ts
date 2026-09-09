import { Fragment, createElement, type ReactNode } from "react";
import type { GloomPlugin, GloomSlots } from "../../types/plugin";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../runtime";

type SlotEntry = {
  pluginId: string;
  order: number;
  render: (props: unknown) => ReactNode;
};

export class RegistrySlots {
  private entries = new Map<string, SlotEntry[]>();
  private unregisterFns = new Map<string, () => void>();

  register(plugin: GloomPlugin, runtime: PluginRuntimeAccess): void {
    if (!plugin.slots) return;
    const registeredSlotNames: string[] = [];
    for (const [slotName, renderer] of Object.entries(plugin.slots)) {
      if (!renderer) continue;
      const entries = this.entries.get(slotName) ?? [];
      entries.push({
        pluginId: plugin.id,
        order: plugin.order ?? 0,
        render: (props: unknown) => createElement(
          PluginRenderProvider,
          {
            pluginId: plugin.id,
            runtime,
            children: createElement(renderer as (props: any) => ReactNode, props),
          },
        ),
      });
      entries.sort((left, right) => left.order - right.order || left.pluginId.localeCompare(right.pluginId));
      this.entries.set(slotName, entries);
      registeredSlotNames.push(slotName);
    }

    this.unregisterFns.set(plugin.id, () => {
      for (const slotName of registeredSlotNames) {
        const entries = this.entries.get(slotName);
        if (!entries) continue;
        const nextEntries = entries.filter((entry) => entry.pluginId !== plugin.id);
        if (nextEntries.length === 0) {
          this.entries.delete(slotName);
        } else {
          this.entries.set(slotName, nextEntries);
        }
      }
    });
  }

  unregister(pluginId: string): void {
    this.unregisterFns.get(pluginId)?.();
    this.unregisterFns.delete(pluginId);
  }

  render<K extends keyof GloomSlots>(name: K, props: GloomSlots[K]): ReactNode {
    const entries = this.entries.get(name as string) ?? [];
    if (entries.length === 0) return null;
    return createElement(
      Fragment,
      null,
      ...entries.map((entry) => createElement(
        Fragment,
        { key: entry.pluginId },
        entry.render(props),
      )),
    );
  }
}
