import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { OptionsView } from "./view";
import {
  LIVE_STREAMING_QUICK_SETTING,
  withLiveStreamingSetting,
} from "../shared/live-streaming";

export const optionsModule: PluginModule = {
  panes: [
    {
      id: "options",
      name: "Options",
      icon: "O",
      component: OptionsView,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 112, height: 28 },
      quickSettings: [LIVE_STREAMING_QUICK_SETTING],
      settings: (context) => withLiveStreamingSetting({ fields: [] }, context.settings),
    },
  ],

  paneTemplates: [
    createTickerSurfacePaneTemplate({
      id: "options-pane",
      paneId: "options",
      label: "Options",
      description: "Options chain for the selected ticker.",
      keywords: ["options", "chain", "calls", "puts", "omon"],
      shortcut: "OMON",
    }),
  ],

  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "options",
      name: "Options",
      order: 35,
      component: OptionsView,
      isVisible: ({ hasOptionsChain }) => hasOptionsChain,
    });
  },
};
