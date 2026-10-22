import type { GloomPlugin } from "../../../types/plugin";
import { DailyBriefPane } from "./pane";
import {
  BRIEF_SECTIONS_SETTING,
  briefTableChoices,
  defaultBriefLayout,
  presentBriefTables,
  resolveBriefLayout,
  serializeBriefLayout,
  storeBriefTables,
} from "./sections";
import {
  createDailyBriefInstance,
  DAILY_BRIEF_PANE_ID,
  DAILY_BRIEF_PLUGIN_ID,
  DAILY_BRIEF_TEMPLATE_ID,
  OPEN_ON_WAKE_SETTING,
} from "./wake";
import { attachDailyBriefFred, detachDailyBriefFred } from "./fred-public";
import { startDailyBriefWake } from "./wake-host";

const BRIEF_DESCRIPTION = "Opens at the start of the day. ES, Nasdaq, crude, the 10-year and 30-year yields, the 30-year mortgage rate, fear and greed, VIX, and the next Fed meeting, plus small tables. Headlines, releases, and earnings are the start; Ask Gloom or the Tables setting can replace those tables with any view.";

let stopWake: (() => void) | null = null;

export const dailyBriefPlugin: GloomPlugin = {
  id: DAILY_BRIEF_PLUGIN_ID,
  name: "Daily Brief",
  version: "1.0.0",
  description: BRIEF_DESCRIPTION,
  toggleable: true,
  setup(ctx) {
    stopWake?.();
    stopWake = startDailyBriefWake(ctx);
    attachDailyBriefFred(ctx.connectionHealth);
  },
  dispose() {
    stopWake?.();
    stopWake = null;
    detachDailyBriefFred();
  },
  panes: [
    {
      id: DAILY_BRIEF_PANE_ID,
      name: "Daily Brief",
      icon: "D",
      component: DailyBriefPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 96, height: 36 },
      settings: (context) => ({
        title: "Daily Brief",
        values: {
          [OPEN_ON_WAKE_SETTING]: true,
          [BRIEF_SECTIONS_SETTING]: serializeBriefLayout(defaultBriefLayout()),
        },
        fields: [{
          key: OPEN_ON_WAKE_SETTING,
          label: "Open on wake",
          description: "Open when the app starts for the day, and when the laptop wakes from sleep after midnight.",
          type: "toggle",
          storage: "plugin",
        }, {
          key: BRIEF_SECTIONS_SETTING,
          label: "Tables",
          description: "The tables under the chart. Check one to show it. Move Up and Move Down change the order. Ask Gloom can add a view, and it shows up here by name.",
          type: "ordered-multi-select",
          storage: "plugin",
          options: briefTableChoices(resolveBriefLayout(
            context.config.pluginConfig[DAILY_BRIEF_PLUGIN_ID]?.[BRIEF_SECTIONS_SETTING],
          )),
          present: presentBriefTables,
          store: storeBriefTables,
        }],
      }),
    },
  ],
  paneTemplates: [
    {
      id: DAILY_BRIEF_TEMPLATE_ID,
      paneId: DAILY_BRIEF_PANE_ID,
      label: "Daily Brief",
      description: BRIEF_DESCRIPTION,
      keywords: ["daily", "brief", "lineup", "morning", "day", "crude", "yield", "mortgage", "fear", "fomc", "wake", "tables", "view"],
      shortcut: { prefix: "DAY" },
      createInstance: (_context, options) => createDailyBriefInstance(options),
    },
  ],
};
