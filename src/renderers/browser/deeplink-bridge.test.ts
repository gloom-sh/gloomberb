import { afterEach, describe, expect, test } from "bun:test";
import { createBrowserDeepLinkBridge } from "./deeplink-bridge";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("browser pane share handoff", () => {
  test("maps a valid share query to the common deep-link runtime", () => {
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
});
