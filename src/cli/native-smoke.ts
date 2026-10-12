export const OPEN_TUI_NATIVE_SMOKE_COMMAND = "__gloomberb-smoke-opentui-native";
export const OPEN_TUI_RUNTIME_SMOKE_COMMAND = "__gloomberb-smoke-opentui-runtime";
export const PLUGIN_HOST_SMOKE_COMMAND = "__gloomberb-smoke-plugin-host";

export async function smokeOpenTuiNative(): Promise<void> {
  await import("../renderers/opentui/native-smoke");
}

export async function smokeOpenTuiRuntime(): Promise<void> {
  await import("../renderers/opentui/start");
  const { assertRendersLeaveNoTimingEntries } = await import("../renderers/opentui/render-timing-smoke");
  await assertRendersLeaveNoTimingEntries();
}

/**
 * Loads a throwaway external plugin the way the terminal loads a real one.
 *
 * A packaged host has no Gloomberb package on disk, so a plugin's
 * `gloomberb/*` and `react` imports only resolve if the host answers them
 * itself. This is what an upgrade relies on: the panes that moved out of the
 * repository come back as plugins, and a binary that cannot load one has
 * lost them. Run against the built binary so a regression fails the build,
 * not the user's first launch.
 */
export async function smokePluginHost(): Promise<void> {
  const { smokePluginHostLoad } = await import("../plugins/host-smoke");
  await smokePluginHostLoad();
}

export const SHOT_VIEW_SMOKE_COMMAND = "__gloomberb-smoke-shot-view";

/**
 * Reads the page `shot` and rendered `fn` reports draw panes in. The release
 * binary has no sources to build it from, so it carries a prebuilt copy; run
 * from outside a checkout, this fails when that copy is missing or incomplete
 * rather than on a user's first capture.
 */
export async function smokeShotView(): Promise<void> {
  const { loadShotView } = await import("./desktop-pane-shot-view");
  await loadShotView();
}
