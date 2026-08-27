import type { PaneProps } from "../types/plugin";
import { getSharedRegistry } from "../plugins/registry";
import { usePluginAppActions } from "../plugins/runtime";
import { LayoutMarketplaceGallery } from "./gallery";

export function LayoutMarketplacePane({ focused, width, height }: PaneProps) {
  const registry = getSharedRegistry();
  const { hidePane } = usePluginAppActions();
  if (!registry) return null;

  return (
    <LayoutMarketplaceGallery
      pluginRegistry={registry}
      focused={focused}
      width={width}
      height={height}
      onClose={() => hidePane("layout-marketplace")}
    />
  );
}
