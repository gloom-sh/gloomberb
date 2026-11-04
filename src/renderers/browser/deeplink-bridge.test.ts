import { afterEach, describe, expect, test } from "bun:test";
import { createBrowserDeepLinkBridge } from "./deeplink-bridge";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("browser social share handoff", () => {
  test("preserves the incoming ticker while the previous workspace restores", () => {
    const location = { search: "?ticker=VOD&exchange=LSE&tab=earnings-calls" };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location, addEventListener() {}, removeEventListener() {},
    } });
    const bridge = createBrowserDeepLinkBridge();
    location.search = "?ticker=AAPL&tab=overview";
    const seen: string[] = [];
    bridge.subscribe(({ url }) => seen.push(url));
    expect(seen).toEqual(["gloomberb://ticker/VOD%3AXLON?tab=earnings-calls"]);
  });
  test("maps a valid pane share query to the common deep-link runtime and consumes it from the address", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const replaced: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { search: `?share=${id}&theme=dark`, pathname: "/", hash: "" },
        history: { state: null, replaceState(_state: unknown, _title: string, url: string) { replaced.push(url); } },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    const seen: string[] = [];
    createBrowserDeepLinkBridge().subscribe((deeplink) => seen.push(deeplink.url));
    expect(seen).toEqual([`gloomberb://share/${id}`]);
    // A reload must not open a second copy of the shared pane.
    expect(replaced).toEqual(["/?theme=dark"]);
  });

  test("hands a function link to the runtime once and consumes it from the address", () => {
    const replaced: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { search: "?fn=perp&arg=BTC-USD&theme=dark", pathname: "/", hash: "" },
        history: { state: null, replaceState(_state: unknown, _title: string, url: string) { replaced.push(url); } },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    const seen: string[] = [];
    createBrowserDeepLinkBridge().subscribe((deeplink) => seen.push(deeplink.url));
    expect(seen).toEqual(["gloomberb://fn/PERP?arg=BTC-USD"]);
    expect(replaced).toEqual(["/?theme=dark"]);
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
