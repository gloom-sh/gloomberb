import { PLUGIN_AUTO_UPDATE_SETTING } from "../../auto-update";
import type { PluginModule } from "../plugin-module";
import { PLUGIN_MARKETPLACE_PANE_ID } from "../../marketplace/ids";

export const pluginMarketplaceModule: PluginModule = {
  panes: [
    {
      id: PLUGIN_MARKETPLACE_PANE_ID,
      name: "Plugins",
      icon: "P",
      get component(): typeof import("./pane").PluginMarketplacePane { const { PluginMarketplacePane } = require("./pane"); return PluginMarketplacePane; },
      reportFreshness: { status: "not-a-feed", basis: "plugin listings", local: true },
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
      description: "Browse and install Gloom plugins, and enable or disable the ones you have.",
      keywords: ["plugin", "plugins", "marketplace", "install", "extend", "addon", "extension"],
      shortcut: { prefix: "PL" },
      createInstance: () => ({ placement: "floating" }),
    },
  ],
};
