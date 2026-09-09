import { getSharedRegistry } from "../../plugins/registry";
import type { GloomSlots } from "../../types/plugin";

export function PluginSlot<K extends keyof GloomSlots>({
  name,
  props,
}: {
  name: K;
  props?: GloomSlots[K];
}) {
  const registry = getSharedRegistry();
  return registry?.renderSlot(name, props ?? ({} as GloomSlots[K])) ?? null;
}
