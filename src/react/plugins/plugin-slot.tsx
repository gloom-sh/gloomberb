import { getSharedRegistry } from "../../plugins/registry";
import { useAppSelector } from "../../state/app/context";
import type { GloomSlots } from "../../types/plugin";

export function PluginSlot<K extends keyof GloomSlots>({
  name,
  props,
}: {
  name: K;
  props?: GloomSlots[K];
}) {
  // Subscribed so toggling a plugin shows or hides its slots right away.
  const disabledPlugins = useAppSelector((state) => state.config.disabledPlugins);
  const registry = getSharedRegistry();
  return registry?.renderSlot(name, props ?? ({} as GloomSlots[K]), disabledPlugins) ?? null;
}
