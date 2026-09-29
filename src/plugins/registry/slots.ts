import { Fragment, createElement, type ReactNode } from "react";
import type { GloomPlugin, GloomSlots } from "../../types/plugin";

type SlotRenderer = (props: unknown) => ReactNode;

type SlotEntry = {
  pluginId: string;
  order: number;
  render: SlotRenderer;
};

export class RegistrySlots {
  private entries = new Map<string, SlotEntry[]>();
  private unregisterFns = new Map<string, () => void>();

  /** `wrap` puts each renderer inside the plugin's render context. */
  register(plugin: GloomPlugin, wrap: (renderer: SlotRenderer) => SlotRenderer): void {
    if (!plugin.slots) return;
    const registeredSlotNames: string[] = [];
    for (const [slotName, renderer] of Object.entries(plugin.slots)) {
      if (!renderer) continue;
      const entries = this.entries.get(slotName) ?? [];
      entries.push({
        pluginId: plugin.id,
        order: plugin.order ?? 0,
        render: wrap(renderer as SlotRenderer),
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

  /** A disabled plugin stays registered but renders nothing until it is enabled again. */
  render<K extends keyof GloomSlots>(name: K, props: GloomSlots[K], disabledPlugins: readonly string[]): ReactNode {
    const entries = (this.entries.get(name as string) ?? [])
      .filter((entry) => !disabledPlugins.includes(entry.pluginId));
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
