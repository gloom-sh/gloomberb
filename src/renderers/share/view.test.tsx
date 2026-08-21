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
