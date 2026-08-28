import { describe, expect, test } from "bun:test";
import { createShare, deleteShare, getShare, openLiveShareUrl, publicShareUrl, SHARE_API_ORIGIN } from "./api";
import { parseSharePayload } from "./payload";

const article = { kind: "article", data: { title: "AAPL", text: "Research", sourceUrl: "https://example.com/a" } } as const;
const portablePane = {
  kind: "pane",
  data: {
    version: 2,
    title: "AAPL Price",
    layout: {
      schemaVersion: 2,
      sourceConfigVersion: 13,
      layout: {
        dockRoot: null,
        instances: [{ instanceId: "p1", paneId: "graph-price", binding: { kind: "fixed", symbol: "AAPL" } }],
        floating: [{ instanceId: "p1", x: 0, y: 0, width: 100, height: 30 }],
        detached: [],
      },
      paneState: {},
    },
  },
} as const;
const shareId = "0123456789abcdef0123456789abcdef";

describe("share API client", () => {
  test("validates strict payloads and http(s)-only source URLs", () => {
    expect(parseSharePayload(article)).toEqual(article);
    expect(parseSharePayload({ ...article, data: { ...article.data, sourceUrl: "javascript:alert(1)" } })).toBeNull();
    expect(parseSharePayload({ kind: "table", data: { title: "x", columns: [], rows: [] } })).toBeNull();
    expect(parseSharePayload({
      kind: "pane",
      data: { version: 1, templateId: "graph-price-pane", title: "AAPL Price", data: { symbol: "AAPL" } },
    })?.kind).toBe("pane");
    expect(parseSharePayload({
      kind: "pane",
      data: { version: 1, templateId: "../private", title: "Private", data: {} },
    })).toBeNull();
    expect(parseSharePayload(portablePane)).toEqual(portablePane);
    expect(parseSharePayload({
      ...portablePane,
      data: {
        ...portablePane.data,
        layout: {
          ...portablePane.data.layout,
          layout: {
            ...portablePane.data.layout.layout,
            instances: [],
            floating: [],
          },
        },
      },
    })).toBeNull();
  });

  test("creates and deletes through api.gloom.sh with credentials", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: shareId, expiresAt: "2026-09-20T00:00:00.000Z" });
    }) as typeof fetch;
    const created = await createShare(article, fetchImpl);
    await deleteShare(created.id, fetchImpl);
    expect(calls[0]).toEqual([`${SHARE_API_ORIGIN}/shares`, expect.objectContaining({ method: "POST", credentials: "include" })]);
    expect(calls[1]).toEqual([`${SHARE_API_ORIGIN}/shares/${shareId}`, expect.objectContaining({ method: "DELETE", credentials: "include" })]);
  });

  test("explains when a Cloud account still needs email verification", async () => {
    const fetchImpl = (async () => Response.json(
      { error: "Email verification required" },
      { status: 403 },
    )) as typeof fetch;
    await expect(createShare(article, fetchImpl)).rejects.toThrow(
      "Verify your Gloom Cloud email to share.",
    );
  });

  test("loads public shares with optional owner credentials and builds current-origin URLs", async () => {
    let init: RequestInit | undefined;
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, options?: RequestInit) => {
      urls.push(String(url));
      init = options;
      return Response.json({
        ...article,
        createdAt: "2026-08-21T00:00:00Z",
        expiresAt: "2026-09-20T00:00:00Z",
        ownedByViewer: true,
      });
    }) as typeof fetch;
    const share = await getShare(shareId, fetchImpl);
    await getShare(shareId, fetchImpl, { trackView: false });
    expect(share?.kind).toBe("article");
    expect(share?.ownedByViewer).toBe(true);
    expect(init?.credentials).toBe("include");
    expect(urls).toEqual([
      `${SHARE_API_ORIGIN}/shares/${shareId}`,
      `${SHARE_API_ORIGIN}/shares/${shareId}?purpose=open`,
    ]);
    expect(publicShareUrl(shareId)).toBe(`https://term.gloom.sh/s/${shareId}`);
    expect(openLiveShareUrl(shareId)).toBe(`https://term.gloom.sh/api/shares/${shareId}/open`);
  });
});
