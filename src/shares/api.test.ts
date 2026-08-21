import { describe, expect, test } from "bun:test";
import { createShare, deleteShare, getShare, publicShareUrl, SHARE_API_ORIGIN } from "./api";
import { parseSharePayload } from "./payload";

const article = { kind: "article", data: { title: "AAPL", text: "Research", sourceUrl: "https://example.com/a" } } as const;
const shareId = "0123456789abcdef0123456789abcdef";

describe("share API client", () => {
  test("validates strict payloads and http(s)-only source URLs", () => {
    expect(parseSharePayload(article)).toEqual(article);
    expect(parseSharePayload({ ...article, data: { ...article.data, sourceUrl: "javascript:alert(1)" } })).toBeNull();
    expect(parseSharePayload({ kind: "table", data: { title: "x", columns: [], rows: [] } })).toBeNull();
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

  test("loads public shares with optional owner credentials and builds current-origin URLs", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL | Request, options?: RequestInit) => {
      init = options;
      return Response.json({
        ...article,
        createdAt: "2026-08-21T00:00:00Z",
        expiresAt: "2026-09-20T00:00:00Z",
        ownedByViewer: true,
      });
    }) as typeof fetch;
    const share = await getShare(shareId, fetchImpl);
    expect(share?.kind).toBe("article");
    expect(share?.ownedByViewer).toBe(true);
    expect(init?.credentials).toBe("include");
    expect(publicShareUrl(shareId, "https://term.gloom.sh")).toBe(`https://term.gloom.sh/s/${shareId}`);
  });
});
