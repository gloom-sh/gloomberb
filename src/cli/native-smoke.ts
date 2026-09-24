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
