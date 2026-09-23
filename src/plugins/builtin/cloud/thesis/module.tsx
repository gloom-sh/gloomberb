import type { PluginModule } from "../../plugin-module";
import { THESIS_PANE_ID, ThesisBoardPane } from "./board-pane";
import { THESIS_PANE_TEMPLATE_ID, openThesisPane, requestThesisPane } from "./pane-request";
import { thesisStore } from "./store";
import { ThesisTickerTab } from "./ticker-tab";

/**
 * Investment theses inside the cloud plugin: the store every surface reads,
 * the `THESIS` board, and the Thesis tab on every ticker. Stored in Gloom
 * Cloud for any account; the AI draft and review are Pro.
 */
export const thesisModule: PluginModule = {
  panes: [{
    id: THESIS_PANE_ID,
    name: "Theses",
    icon: "Θ",
    component: ThesisBoardPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 110, height: 32 },
    portableShare: {
      private: { title: true, params: true, settings: true, state: true },
    },
  }],
  paneTemplates: [{
    id: THESIS_PANE_TEMPLATE_ID,
    paneId: THESIS_PANE_ID,
    label: "Theses",
    description: "Every thesis you and your teams hold, sorted by what needs a ruling",
    keywords: ["thesis", "theses", "conviction", "invalidation", "kill", "pillars", "journal"],
    shortcut: { prefix: "THESIS", argPlaceholder: "tickers (optional)", argKind: "text" },
    createInstance: (_context, options) => {
      // `THESIS NVDA` opens that thesis or starts one; `THESIS NVDA AMD` starts a pair.
      const symbol = options?.arg?.trim() || null;
      if (symbol) requestThesisPane({ symbol, start: true });
      return { placement: "floating", instanceId: "thesis-board" };
    },
  }],
  setup(ctx) {
    thesisStore.attach(ctx.persistence);
    thesisStore.setNotifier(ctx.notify, (thesisId) => openThesisPane(ctx.createPaneFromTemplate, { thesisId }));
    thesisStore.start();
    ctx.registerTickerResearchTab({
      id: "thesis",
      name: "Thesis",
      order: 55,
      component: ThesisTickerTab,
    });
    // Right-click on a portfolio or watchlist row, or the command bar with a
    // ticker in focus: open its thesis, or start one from there.
    ctx.registerTickerAction({
      id: "thesis",
      label: "Thesis",
      keywords: ["thesis", "conviction", "kill condition", "why do I own this"],
      execute: (ticker) => {
        openThesisPane(ctx.createPaneFromTemplate, { symbol: ticker.metadata.ticker, start: true });
      },
    });
  },
  dispose() {
    thesisStore.dispose();
  },
};
