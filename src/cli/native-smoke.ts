export const OPEN_TUI_NATIVE_SMOKE_COMMAND = "__gloomberb-smoke-opentui-native";
export const OPEN_TUI_RUNTIME_SMOKE_COMMAND = "__gloomberb-smoke-opentui-runtime";

export async function smokeOpenTuiNative(): Promise<void> {
  await import("../renderers/opentui/native-smoke");
}

export async function smokeOpenTuiRuntime(): Promise<void> {
  await import("../renderers/opentui/start");
}
