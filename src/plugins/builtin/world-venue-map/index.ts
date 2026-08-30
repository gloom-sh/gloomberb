import type { PluginModule } from "../plugin-module";
import { WORLD_VENUE_MAP_PANE_ID, WorldVenueMapPane } from "./pane";

export const worldVenueMapModule: PluginModule = {
  panes: [
    {
      id: WORLD_VENUE_MAP_PANE_ID,
      name: "World Venue Map",
      icon: "M",
      component: WorldVenueMapPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 124, height: 36 },
    },
  ],
  paneTemplates: [
    {
      id: "world-venue-map-pane",
      paneId: WORLD_VENUE_MAP_PANE_ID,
      label: "World Venue Map",
      description: "Live trading venue status, local time, and exchange locations around the world.",
      keywords: ["world", "map", "venue", "venues", "exchange", "mic", "market hours", "open markets"],
      shortcut: { prefix: "MAP" },
      createInstance: () => ({ placement: "floating" }),
    },
  ],
};
