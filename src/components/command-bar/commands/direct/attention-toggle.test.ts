import { expect, test } from "bun:test";
import { createInitialState } from "../../../../state/app/context";
import { createDefaultConfig } from "../../../../types/config";
import { reportTelemetryConfig, subscribeTelemetryConfig } from "../../../../telemetry/live-config";
import type { PluginRegistry } from "../../../../plugins/registry";
import { commands } from "../registry";
import { runDirectCommandAction } from "./index";

test("Attention Counts starts on: the toggle switches it off at once, then back on, keeping the notice record", () => {
  let state = createInitialState(createDefaultConfig("/tmp/attention-command"));
  state.config.telemetry = { usage: false, attentionNoticeShownTo: ["user-1"] };
  const reported: unknown[] = [];
  const stop = subscribeTelemetryConfig(() => { reported.push(structuredClone(state.config.telemetry)); });
  const nothing = () => {};
  const run = () => runDirectCommandAction({
    command: commands.find((entry) => entry.id === "toggle-attention-counts")!,
    arg: "", activeCollectionId: null, activeTickerSymbol: null,
    closeAll: nothing, controlWindow: nothing, executeCollectionCommand: nothing, notify: nothing,
    openBuiltInWorkflow: nothing, openModeRoute: nothing, openPaneSettings: nothing,
    pushRoute: nothing, quitApp: nothing, runSecurityDescriptionShortcut: nothing,
    setRootQuery: nothing, setRootThemeBaseId: nothing, cancelThemePreview: nothing,
    pluginRegistry: {} as PluginRegistry, getState: () => state, openInlineConfirm: nothing,
    dispatch: (action) => { if (action.type === "SET_CONFIG") state = { ...state, config: action.config }; },
    persistConfig: nothing,
  });
  try {
    run();
    expect(state.config.telemetry).toEqual({ usage: false, attentionNoticeShownTo: ["user-1"], attention: false });
    // Reported before the settings update commits, so the collector drops unsent counts first.
    expect(reported).toEqual([{ usage: false, attentionNoticeShownTo: ["user-1"] }]);
    run();
    expect(state.config.telemetry?.attention).toBe(true);
  } finally {
    stop();
    reportTelemetryConfig(undefined);
  }
});
