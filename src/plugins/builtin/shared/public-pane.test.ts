import { expect, test } from "bun:test";
import { createPublicPaneShare } from "./public-pane";

test("default public pane shares restore no user-owned state", () => {
  const adapter = createPublicPaneShare("World Equity Indices");
  expect(adapter.serialize({
    pane: { instanceId: "world", paneId: "world-indices", settings: { symbols: ["private"] } },
    paneState: { selectedIndex: 2 },
  })).toEqual({ title: "World Equity Indices", data: {} });
  expect(adapter.restore({})).toEqual({});
  expect(adapter.restore({ token: "secret" })).toBeNull();
});
