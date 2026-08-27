import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LayoutMarketplaceEntry } from "../../layout-marketplace/payload";
import { LayoutShareView } from "./layout-view";

const entry: LayoutMarketplaceEntry = {
  id: "0123456789abcdef0123456789abcdef",
  name: "Social <script>alert(1)</script> Desk",
  schemaVersion: 2,
  sourceConfigVersion: 21,
  layout: {
    dockRoot: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.6,
      first: { kind: "pane", instanceId: "p1" },
      second: { kind: "pane", instanceId: "p2" },
    },
    instances: [
      {
        instanceId: "p1",
        paneId: "twitter-feed",
        params: { query: "$NVDA <img src=x onerror=alert(1)>" },
      },
      {
        instanceId: "p2",
        paneId: "chart-composer",
        binding: { kind: "fixed", symbol: "NVDA" },
      },
    ],
    floating: [],
    detached: [],
  },
  paneState: {},
  author: { username: "analyst", displayName: "Analyst" },
  publishedAt: "2026-08-27T00:00:00.000Z",
};

test("shared layout renders a safe workspace preview and live-copy CTA", () => {
  const html = renderToStaticMarkup(
    <LayoutShareView
      entry={entry}
      openLiveUrl="https://term.gloom.sh/?layout=0123456789abcdef0123456789abcdef"
    />,
  );

  expect(html).toContain("Shared via Gloomberb");
  expect(html).toContain("X Feed");
  expect(html).toContain("Chart");
  expect(html).toContain("$NVDA");
  expect(html).toContain("Use this layout");
  expect(html).toContain("independent, editable copy");
  expect(html).toContain('href="https://term.gloom.sh/?layout=0123456789abcdef0123456789abcdef"');
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;img");
});
