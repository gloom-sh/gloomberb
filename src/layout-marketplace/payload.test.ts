import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../types/config";
import {
  parseMarketplaceLayoutEntry,
  parseMarketplaceLayoutList,
  publishableMarketplaceLayout,
} from "./payload";

function validEntry() {
  const payload = publishableMarketplaceLayout(createDefaultConfig("/tmp/layout-marketplace-test").layout);
  return {
    id: "0123456789abcdef0123456789abcdef",
    name: "Research Desk",
    ...payload,
    author: { username: "analyst", displayName: "Analyst" },
    publishedAt: "2026-08-26T00:00:00.000Z",
  };
}

describe("layout marketplace payloads", () => {
  test("publishes only portable pane structure", () => {
    const config = createDefaultConfig("/tmp/layout-marketplace-test");
    config.layout.instances[0] = {
      ...config.layout.instances[0]!,
      title: "Private desk",
      params: { collectionId: "private-portfolio" },
      settings: { prompt: "private", token: "secret" },
      placementMemory: { floating: { x: 1, y: 2, width: 20, height: 8 } },
    };
    config.layout.instances.push({
      instanceId: "layout-marketplace:main",
      paneId: "layout-marketplace",
      binding: { kind: "none" },
    });
    config.layout.floating.push({
      instanceId: "layout-marketplace:main",
      x: 10,
      y: 4,
      width: 100,
      height: 32,
    });

    const payload = publishableMarketplaceLayout(config.layout);

    expect(payload.layout.instances[0]).toEqual({
      instanceId: config.layout.instances[0]!.instanceId,
      paneId: config.layout.instances[0]!.paneId,
      binding: config.layout.instances[0]!.binding,
    });
    expect(JSON.stringify(payload)).not.toContain("private");
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(JSON.stringify(payload)).not.toContain("layout-marketplace");
  });

  test("rejects malformed marketplace responses before they reach app state", () => {
    const entry = validEntry();
    expect(parseMarketplaceLayoutList({ items: [entry] })).toEqual([entry]);

    const withSettings = structuredClone(entry);
    (withSettings.layout.instances[0] as Record<string, unknown>).settings = { url: "https://example.com" };
    expect(parseMarketplaceLayoutEntry(withSettings)).toBeNull();

    const dangling = structuredClone(entry);
    dangling.layout.dockRoot = { kind: "pane", instanceId: "missing" };
    expect(parseMarketplaceLayoutEntry(dangling)).toBeNull();
  });
});
