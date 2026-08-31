import type { PluginModule } from "../plugin-module";
import { PluginMarketplacePane, PLUGIN_MARKETPLACE_PANE_ID } from "./pane";

export { PLUGIN_MARKETPLACE_PANE_ID } from "./pane";
export { setMarketplaceHost } from "./store";

export const pluginMarketplaceModule: PluginModule = {
  panes: [
    {
      id: PLUGIN_MARKETPLACE_PANE_ID,
      name: "Plugins",
      icon: "P",
      component: PluginMarketplacePane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 118, height: 34 },
    },
  ],

  paneTemplates: [
    {
      id: "plugin-marketplace-pane",
      paneId: PLUGIN_MARKETPLACE_PANE_ID,
      label: "Plugins",
      description: "Browse and install Gloomberb plugins, and enable or disable the ones you have.",
      keywords: ["plugin", "plugins", "marketplace", "install", "extend", "addon", "extension"],
      shortcut: { prefix: "PL" },
      createInstance: () => ({ placement: "floating" }),
    },
  ],
};
