import { expect, test } from "bun:test";
import { createInitialState } from "../../../../core/state/app/state";
import {
  createDefaultConfig,
  createPaneInstance,
  TICKER_RESEARCH_PANE_ID,
} from "../../../../types/config";
import type { PaneTemplateDef } from "../../../../types/plugin";
import { commandPromptTicker } from "../../../../layout/selected-ticker";
import { buildRootShortcutFeedback } from "./shortcut-feedback";
import { parseRootShortcutIntent } from "./shortcuts";

const fa: PaneTemplateDef = {
  id: "financial-analysis-pane",
  paneId: "financial-analysis",
  label: "Financial Analysis",
  description: "FA shortcut",
  shortcut: { prefix: "FA", argPlaceholder: "ticker", argKind: "ticker" },
};

test("a required ticker shortcut names the linked desk's ticker it will use", () => {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-shortcut-feedback"));
  const des = createPaneInstance(TICKER_RESEARCH_PANE_ID, {
    instanceId: "des",
    binding: { kind: "fixed", symbol: "AAPL" },
  });
  const chart = createPaneInstance("chart-composer", {
    instanceId: "chart",
    binding: { kind: "follow", sourceInstanceId: "des" },
  });
  const news = createPaneInstance("news-top", { instanceId: "news", binding: { kind: "none" } });
  state.config.layout = {
    dockRoot: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", instanceId: "des" },
      second: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "pane", instanceId: "chart" },
        second: { kind: "pane", instanceId: "news" },
      },
    },
    instances: [des, chart, news],
    floating: [],
    detached: [],
  };
  state.focusedPaneId = "news";

  const rootShortcutIntent = parseRootShortcutIntent({
    query: "FA",
    commands: [],
    paneTemplates: [fa],
    activeTicker: null,
    promptTicker: commandPromptTicker(state)?.symbol ?? null,
  });
  expect(buildRootShortcutFeedback({
    activeCollectionId: null,
    activeTickerSymbol: null,
    currentRoute: null,
    rootShortcutIntent,
    state,
  })).toBe("Shortcut: Financial Analysis for AAPL · Tab to accept");
});
