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

test("portable pane share renders sanitized pane configuration", () => {
  const html = renderToStaticMarkup(<ShareView
    share={{
      kind: "pane",
      data: {
        version: 2,
        title: "Fed Markets",
        description: "Prediction markets filtered to the Fed.",
        layout: {
          schemaVersion: 2,
          sourceConfigVersion: 13,
          layout: {
            dockRoot: null,
            instances: [{
              instanceId: "p1",
              paneId: "prediction-markets",
              binding: { kind: "none" },
              params: { query: "fed", scope: "polymarket" },
            }],
            floating: [{ instanceId: "p1", x: 0, y: 0, width: 100, height: 30 }],
            detached: [],
          },
          paneState: {},
        },
      },
      createdAt: "2026-08-25T00:00:00Z",
      expiresAt: "2026-09-24T00:00:00Z",
      ownedByViewer: false,
    }}
    openLiveUrl="https://api.gloom.sh/shares/abc/open"
  />);
  expect(html).toContain("Fed Markets");
  expect(html).toContain("Prediction Markets");
  expect(html).toContain("Query");
  expect(html).toContain("fed");
  expect(html).toContain("polymarket");
  expect(html).toContain("Explore this pane live");
  expect(html).not.toContain("p1");
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

test("chart snapshot retains exact values, gaps and units without a fabricated empty-panel scale", () => {
  const html = renderToStaticMarkup(<ShareView share={{
    kind: "chart",
    data: { title: "Research snapshot", series: [
      { name: "Price", unit: "USD", points: [{ x: "2026-01-01", y: 123.456789 }, { x: "2026-01-02", y: null }, { x: "2026-01-03", y: 124 }] },
      { name: "Missing yield", unit: "%", points: [{ x: "2026-01-01", y: null }] },
    ], warnings: ["Partial history"] },
    createdAt: "2026-09-10T12:00:00Z", expiresAt: "2026-10-10T12:00:00Z", ownedByViewer: false,
  }} />);
  expect(html).toContain("123.456789");
  expect(html).toContain("Unavailable");
  expect(html).toContain("Partial history");
  expect(html).toContain("Snapshot shared 2026-09-10 12:00 UTC");
  expect(html.match(/<circle/g)).toHaveLength(2);
  expect(html).not.toContain("<polyline");
  const emptyPanel = html.slice(html.indexOf('aria-label="% chart"'), html.indexOf('class="chart-notes"'));
  expect(emptyPanel).toContain("No observations available");
  expect(emptyPanel).not.toContain("chart-y-axis");
});
