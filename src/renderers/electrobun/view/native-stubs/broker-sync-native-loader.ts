export function loadRobinhoodNativeModule(): Promise<never> {
  return Promise.reject(new Error("Robinhood native sync is unavailable in the desktop web renderer."));
}

export function loadSimpleFinNativeModule(): Promise<never> {
  return Promise.reject(new Error("SimpleFIN native sync is unavailable in the desktop web renderer."));
}
