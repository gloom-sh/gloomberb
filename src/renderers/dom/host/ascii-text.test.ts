import { afterEach, describe, expect, test } from "bun:test";
import { webAsciiTextWordmarkVariant } from "./ascii-text";

const globalWithNavigator = globalThis as { navigator?: unknown };
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function stubNavigator(platform: string): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { platform, userAgent: platform },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete globalWithNavigator.navigator;
});

/**
 * The block-glyph wordmark only renders on macOS fonts, so every other platform
 * gets the `/ \ | _` fallback. The DOM host is shared by Electrobun, which knows
 * its `process.platform`, and the hosted web build, which does not and passes a
 * sentinel instead. Reading that sentinel as "not macOS" is what shipped the
 * wrong wordmark to Mac browsers.
 */
describe("web wordmark variant", () => {
  test("trusts a real platform from the desktop host over the navigator", () => {
    stubNavigator("MacIntel");
    expect(webAsciiTextWordmarkVariant("Gloomberb", "wordmark", "darwin")).toBe("legacy");
    expect(webAsciiTextWordmarkVariant("Gloomberb", "wordmark", "win32")).toBe("compat");
    expect(webAsciiTextWordmarkVariant("Gloomberb", "wordmark", "linux")).toBe("compat");
  });

  test("falls back to the navigator when the host names no OS", () => {
    stubNavigator("MacIntel");
    expect(webAsciiTextWordmarkVariant("Gloomberb", "wordmark", "browser")).toBe("legacy");
    expect(webAsciiTextWordmarkVariant("Gloomberb", "wordmark", "")).toBe("legacy");
    stubNavigator("Win32");
    expect(webAsciiTextWordmarkVariant("Gloomberb", "wordmark", "browser")).toBe("compat");
  });

  test("leaves anything that is not the wordmark alone", () => {
    stubNavigator("MacIntel");
    expect(webAsciiTextWordmarkVariant("Gloomberb", "tiny", "darwin")).toBeNull();
    expect(webAsciiTextWordmarkVariant("Portfolio", "wordmark", "darwin")).toBeNull();
  });
});
