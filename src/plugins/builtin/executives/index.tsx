import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  attachExecutivesPersistence,
  resetExecutivesPersistence,
} from "./data";
import { EXECUTIVES_PANE_ID, ExecutivesPane } from "./pane";

const description =
  "Named executive officers and what they were paid, read from the company's proxy statement and checked against the filing.";

export const executivesModule: PluginModule = {
  setup(ctx) {
    attachExecutivesPersistence(ctx.persistence);
    ctx.registerTickerResearchTab({
      id: "executives",
      name: "Exec",
      order: 35,
      component: ExecutivesPane,
      isVisible: ({ ticker }) => !!ticker,
    });
  },

  dispose() {
    resetExecutivesPersistence();
  },

  panes: [
    {
      id: EXECUTIVES_PANE_ID,
      name: "Executives",
      icon: "X",
      component: ExecutivesPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
    },
  ],

  paneTemplates: [
    createTickerSurfacePaneTemplate({
      id: "executives-pane",
      paneId: EXECUTIVES_PANE_ID,
      label: "Executives",
      description,
      keywords: [
        "executive",
        "executives",
        "exec",
        "ceo",
        "compensation",
        "pay",
        "proxy",
        "def 14a",
        "salary",
      ],
      shortcut: "EXEC",
      publicShare: false,
    }),
  ],
};
