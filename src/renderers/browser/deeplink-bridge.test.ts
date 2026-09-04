import { afterEach, describe, expect, test } from "bun:test";
import { createBrowserDeepLinkBridge } from "./deeplink-bridge";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("browser social share handoff", () => {
  test("preserves the incoming ticker while the previous workspace restores", () => {
    const location = { search: "?ticker=NVDA&tab=earnings-calls" };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location, addEventListener() {}, removeEventListener() {},
    } });
    const bridge = createBrowserDeepLinkBridge();
    location.search = "?ticker=AAPL&tab=overview";
    const seen: string[] = [];
    bridge.subscribe(({ url }) => seen.push(url));
    expect(seen).toEqual(["gloomberb://ticker/NVDA?tab=earnings-calls"]);
  });
  test("maps a valid pane share query to the common deep-link runtime", () => {
    const id = "0123456789abcdef0123456789abcdef";
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { search: `?share=${id}` },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    const seen: string[] = [];
    createBrowserDeepLinkBridge().subscribe((deeplink) => seen.push(deeplink.url));
    expect(seen).toEqual([`gloomberb://share/${id}`]);
  });

  test("prefers a shared layout query", () => {
    const id = "fedcba9876543210fedcba9876543210";
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { search: `?layout=${id}&share=0123456789abcdef0123456789abcdef` },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    const seen: string[] = [];
    createBrowserDeepLinkBridge().subscribe((deeplink) => seen.push(deeplink.url));
    expect(seen).toEqual([`gloomberb://layout/${id}`]);
  });
});
