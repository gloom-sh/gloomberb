import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../../../api-client/errors";
import type { Letter } from "../../../../../api-client/letters";
import { fetchLetters, letterPageLoader, parseLetters } from "./client";
import { letterColumns, letterKindFilter } from "./model";
import { NEWS_INDUSTRY_CODES, parseNewsIndustryCode } from "../news/query-presets";

const letter = (overrides: Partial<Letter> = {}): Letter => ({
  id: "1",
  title: "AI Hurtles Ahead",
  entity: "Oaktree Capital Management",
  kind: "memo",
  date: "2026-02-26",
  url: "https://www.oaktreecapital.com/insights/memo/ai-hurtles-ahead",
  ...overrides,
});
const page = (items: unknown[], hasMore = false) => ({ items: items as Letter[], hasMore, limit: 50, offset: 0 });

test("LTR is a Topic News code, reachable as ltr or letters, and is the one code that lists no stories", () => {
  expect(parseNewsIndustryCode("ltr")?.code).toBe("LTR");
  expect(parseNewsIndustryCode("Letters")?.code).toBe("LTR");
  const entry = NEWS_INDUSTRY_CODES.find((code) => code.code === "LTR");
  expect(entry).toMatchObject({ label: "Letters", letters: true });
  expect(entry?.topic).toBeUndefined();
  expect(entry?.sector).toBeUndefined();
});

test("a reply is checked field by field: an unknown kind, a bad date or a link that is not a web page is unreadable", () => {
  expect(parseLetters(page([letter()]))).toEqual(page([letter()]));
  for (const bad of [
    letter({ url: "javascript:alert(1)" }),
    letter({ url: "file:///etc/passwd" }),
    letter({ date: "2026-13-40" }),
    letter({ kind: "news" as never }),
    letter({ title: " " }),
    letter({ id: "" }),
  ]) {
    expect(() => parseLetters(page([letter(), bad]))).toThrow("unreadable letters");
  }
  expect(() => parseLetters({ ...page([]), hasMore: "yes" })).toThrow("unreadable letters");
  expect(() => parseLetters({ error: "not_found" })).toThrow("unreadable letters");
  // Fields the app does not draw are dropped, never carried along.
  expect(Object.keys(parseLetters(page([{ ...letter(), summary: "extra" }])).items[0]!)).not.toContain("summary");
});

test("pages follow the server's offset, carry the kind filter, and stop at the route's offset ceiling", async () => {
  const calls: unknown[] = [];
  const client = {
    getPublicLetters: async (params: unknown) => {
      calls.push(params);
      const offset = (params as { offset: number }).offset;
      return { items: [letter({ id: String(offset) })], hasMore: true, limit: 50, offset };
    },
  };
  const load = letterPageLoader("memo", client as never);
  const first = await load({ offset: 0, signal: new AbortController().signal, force: false });
  expect(first).toMatchObject({ hasMore: true, nextOffset: 1 });
  expect(calls[0]).toEqual({ kind: "memo", limit: 50, offset: 0 });
  const last = await load({ offset: 2_000, signal: new AbortController().signal, force: false });
  expect(last.hasMore).toBe(false);
  await letterPageLoader(null, client as never)({ offset: 0, signal: new AbortController().signal, force: false });
  expect(calls[2]).toEqual({ limit: 50, offset: 0 });
});

test("a server that does not serve letters yet reads as unavailable, not as a broken request", async () => {
  const missing = { getPublicLetters: async () => { throw new ApiRequestError("Not found", 404); } };
  await expect(fetchLetters({}, missing as never)).rejects.toThrow("Letters are not available right now.");
  const broken = { getPublicLetters: async () => { throw new ApiRequestError("Boom", 500); } };
  await expect(fetchLetters({}, broken as never)).rejects.toThrow("Boom");
});

test("narrow panes drop the kind, then the entity, and keep the date and title", () => {
  expect(letterColumns(98).map((column) => column.id)).toEqual(["date", "entity", "title", "kind"]);
  expect(letterColumns(84).map((column) => column.id)).toEqual(["date", "entity", "title"]);
  expect(letterColumns(40).map((column) => column.id)).toEqual(["date", "title"]);
  expect(letterKindFilter("memo")).toBe("memo");
  expect(letterKindFilter("all")).toBeNull();
  expect(letterKindFilter("bogus")).toBeNull();
});
