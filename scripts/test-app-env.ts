export function testAppEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    GLOOMBERB_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  };
}

export const TEST_BROWSER_PRIVACY_SCRIPT = 'if (navigator.doNotTrack !== "1") Object.defineProperty(navigator, "doNotTrack", { get: () => "1", configurable: true });';
