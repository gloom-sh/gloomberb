import { PLUGIN_AUTO_UPDATE_SETTING } from "../../auto-update";
import type { PluginModule } from "../plugin-module";
import { PLUGIN_MARKETPLACE_PANE_ID } from "./ids";
import { PluginMarketplacePane } from "./pane";

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
      settings: {
        title: "Plugins Settings",
        values: { [PLUGIN_AUTO_UPDATE_SETTING.key]: true },
        fields: [
          {
            key: PLUGIN_AUTO_UPDATE_SETTING.key,
            label: "Update official plugins automatically",
            description: "Plugins published by Gloom move to their newest compatible version in the background. Others update when you ask.",
            type: "toggle",
            storage: "plugin",
          },
        ],
      },
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
