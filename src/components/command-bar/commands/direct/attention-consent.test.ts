import { expect, test } from "bun:test";
import { createInitialState } from "../../../../state/app/context";
import { createDefaultConfig } from "../../../../types/config";
import { reportTelemetryConfig, subscribeTelemetryConfig } from "../../../../telemetry/live-config";
import { PluginRegistry } from "../../../../plugins/registry";
import type { ConfirmModalOptions } from "../../../form-modal/request";
import { commands } from "../registry";
import { runDirectCommandAction } from "./index";

test("attention requires a separate confirmation, keeps current settings and disables synchronously", async () => {
  let state = createInitialState(createDefaultConfig("/tmp/attention-command"));
  state.config.telemetry = { usage: true };
  let confirmation: ConfirmModalOptions | undefined;
  let saves = 0;
  let changes = 0;
  const stop = subscribeTelemetryConfig(() => { changes += 1; });
  const nothing = () => {};
  const run = () => runDirectCommandAction({
    command: commands.find((entry) => entry.id === "toggle-attention-counts")!,
    arg: "", activeCollectionId: null, activeTickerSymbol: null,
    closeAll: nothing, controlWindow: nothing, executeCollectionCommand: nothing, notify: nothing,
    openBuiltInWorkflow: nothing, openModeRoute: nothing, openPaneSettings: nothing,
    pushRoute: nothing, quitApp: nothing, runSecurityDescriptionShortcut: nothing,
    setRootQuery: nothing, setRootThemeBaseId: nothing, cancelThemePreview: nothing,
    pluginRegistry: new PluginRegistry(), getState: () => state,
    openInlineConfirm: (request) => { confirmation = request; },
    dispatch: (action) => { if (action.type === "SET_CONFIG") state = { ...state, config: action.config }; },
    persistConfig: () => { saves += 1; },
  });
  try {
    run();
    expect(confirmation).toBeDefined();
    expect(state.config.telemetry?.attention).toBeUndefined();
    expect(saves).toBe(0);
    expect(changes).toBe(0);
    // Another setting changed while the dialog was open must survive consent.
    state = { ...state, config: { ...state.config, telemetry: { usage: false } } };
    await confirmation!.onConfirm();
    expect(state.config.telemetry).toEqual({ usage: false, attention: true });
    expect(saves).toBe(1);
    expect(changes).toBe(1);
    confirmation = undefined;
    run();
    expect(confirmation).toBeUndefined();
    expect(state.config.telemetry).toEqual({ usage: false, attention: false });
    expect(saves).toBe(2);
    expect(changes).toBe(2);
  } finally {
    stop();
    reportTelemetryConfig(undefined);
  }
});
