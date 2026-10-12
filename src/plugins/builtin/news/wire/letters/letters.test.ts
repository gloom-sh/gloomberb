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
  date_basis: "published",
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

test("a reply is checked field by field: an unknown or inherited kind or basis, a day that is not on the calendar, or a link that is not a web page is unreadable", () => {
  expect(parseLetters(page([letter()]))).toEqual(page([letter()]));
  expect(parseLetters(page([letter({ date_basis: "file_modified" })])).items[0]!.date_basis).toBe("file_modified");
  for (const bad of [
    letter({ url: "javascript:alert(1)" }),
    letter({ url: "file:///etc/passwd" }),
    letter({ date: "2026-13-40" }),
    letter({ date: "2026-02-30" }),
    letter({ date: "2025-02-29" }),
    letter({ kind: "news" as never }),
    letter({ kind: "constructor" as never }),
    letter({ kind: "__proto__" as never }),
    letter({ kind: "toString" as never }),
    letter({ date_basis: "first_seen" as never }),
    letter({ date_basis: "constructor" as never }),
    letter({ date_basis: undefined as never }),
    letter({ title: " " }),
    letter({ id: "" }),
  ]) {
    expect(() => parseLetters(page([letter(), bad]))).toThrow("unreadable letters");
  }
  expect(parseLetters(page([letter({ date: "2024-02-29" })])).items).toHaveLength(1);
  expect(() => parseLetters({ ...page([]), hasMore: "yes" })).toThrow("unreadable letters");
  expect(() => parseLetters({ error: "not_found" })).toThrow("unreadable letters");
  // Fields the app does not draw are dropped, never carried along.
  expect(Object.keys(parseLetters(page([{ ...letter(), summary: "extra" }])).items[0]!)).not.toContain("summary");
});

test("a page outside the route's bounds is unreadable: limit 1 to 200, offset up to 2,000, no more items than its limit", () => {
  for (const bounds of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { offset: -1 }, { offset: 2_001 }, { limit: 1 }]) {
    expect(() => parseLetters({ ...page([letter({ id: "1" }), letter({ id: "2" })]), ...bounds })).toThrow("unreadable letters");
  }
  expect(parseLetters({ ...page([letter()]), limit: 200, offset: 2_000 }).limit).toBe(200);
});

test("paging can never spin in place: an empty page ends the list and a page for another offset is unreadable", async () => {
  const empty = { getPublicLetters: async () => ({ items: [], hasMore: true, limit: 50, offset: 0 }) };
  const first = await letterPageLoader(null, empty as never)({ offset: 0, signal: new AbortController().signal, force: false });
  expect(first).toMatchObject({ rows: [], hasMore: false });
  const shifted = { getPublicLetters: async () => ({ items: [letter()], hasMore: true, limit: 50, offset: 0 }) };
  await expect(letterPageLoader(null, shifted as never)({ offset: 50, signal: new AbortController().signal, force: false })).rejects.toThrow("unreadable letters");
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

test("narrow panes drop the kind, then the entity, then the date basis, and keep the date and title", () => {
  expect(letterColumns(110).map((column) => column.id)).toEqual(["date", "basis", "entity", "title", "kind"]);
  expect(letterColumns(84).map((column) => column.id)).toEqual(["date", "basis", "entity", "title"]);
  expect(letterColumns(56).map((column) => column.id)).toEqual(["date", "basis", "title"]);
  expect(letterColumns(40).map((column) => column.id)).toEqual(["date", "title"]);
});

test("a saved kind filter is one of the four kinds or none, never an inherited name", () => {
  expect(letterKindFilter("memo")).toBe("memo");
  for (const value of ["all", "bogus", "constructor", "__proto__", "toString", "hasOwnProperty"])
    expect(letterKindFilter(value)).toBeNull();
});
