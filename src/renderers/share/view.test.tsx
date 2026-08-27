import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ShareView } from "./view";

test("share rendering escapes content and protects external links", () => {
  const html = renderToStaticMarkup(<ShareView share={{
    kind: "article",
    data: {
      title: "<img src=x onerror=alert(1)>",
      text: "<script>alert(1)</script>",
      sourceUrl: "https://example.com/story",
    },
    createdAt: "2026-08-21T00:00:00Z",
    expiresAt: "2026-09-20T00:00:00Z",
    ownedByViewer: true,
  }} onDelete={() => {}} />);
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("Delete share");
});

test("pane share renders the handoff copy, tracked CTA and printable facts only", () => {
  const html = renderToStaticMarkup(<ShareView
    share={{
      kind: "pane",
      data: {
        version: 1,
        templateId: "watchlist",
        title: "Momentum <script>alert(1)</script>",
        description: "Movers I watch daily.",
        data: {
          symbols: ["AAPL", "MSFT"],
          lookbackDays: 90,
          blank: "   ",
          nestedConfig: { hidden: true },
        },
      },
      createdAt: "2026-08-25T00:00:00Z",
      expiresAt: "2026-09-24T00:00:00Z",
      ownedByViewer: true,
    }}
    openLiveUrl="https://api.gloom.sh/shares/abc/open"
    onDelete={() => {}}
  />);
  expect(html).toContain("Shared via Gloomberb");
  expect(html).toContain("A free, open-source finance terminal for market data, charts, and research.");
  expect(html).toContain('href="https://api.gloom.sh/shares/abc/open"');
  expect(html).toContain("Explore this pane live");
  expect(html).toContain("Movers I watch daily.");
  expect(html).toContain("Symbols");
  expect(html).toContain("AAPL, MSFT");
  expect(html).toContain("Lookback Days");
  expect(html).not.toContain("[object Object]");
  expect(html).not.toContain("Nested Config");
  expect(html).not.toContain("Blank");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Delete share");
});
