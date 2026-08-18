export type RobinhoodNativeModule = typeof import("./robinhood-native");
export type SimpleFinNativeModule = typeof import("./simplefin-native");

export function loadRobinhoodNativeModule(): Promise<RobinhoodNativeModule> {
  return import("./robinhood-native");
}

export function loadSimpleFinNativeModule(): Promise<SimpleFinNativeModule> {
  return import("./simplefin-native");
}
