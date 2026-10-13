import { afterEach, expect, test } from "bun:test";
import { isPaneShareHandoff, paneShareIdFromSearch, paneShareIdFromUrl } from "./location";

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

test("pane share handoff tolerates renderer globals without browser location", () => {
  (globalThis as { window?: unknown }).window = {};
  expect(isPaneShareHandoff()).toBe(false);

  const id = "0123456789abcdef0123456789abcdef";
  (globalThis as { window?: unknown }).window = { location: { search: `?share=${id}` } };
  expect(isPaneShareHandoff()).toBe(true);
  expect(paneShareIdFromSearch(`?share=${id}`)).toBe(id);
});

test("only Gloom's own share links name a share, so a look-alike link stays a link", () => {
  const id = "0123456789abcdef0123456789abcdef";
  for (const link of [
    `https://term.gloom.sh/api/shares/${id}/open`,
    `https://term.gloom.sh/s/${id}`,
    `https://term.gloom.sh/s/${id}/`,
    `https://term.gloom.sh/?share=${id}`,
    `https://api.gloom.sh/shares/${id}/open`,
  ]) expect(paneShareIdFromUrl(link)).toBe(id);
  for (const link of [
    `http://term.gloom.sh/s/${id}`,
    `https://term.gloom.sh.example.com/s/${id}`,
    `https://example.com/s/${id}?share=${id}`,
    `https://user@term.gloom.sh/s/${id}`,
    `https://term.gloom.sh:8443/s/${id}`,
    `https://term.gloom.sh/s/${id.toUpperCase()}`,
    `https://term.gloom.sh/docs?share=${id}`,
    `https://term.gloom.sh/api/shares/${id}`,
    `https://api.gloom.sh/shares/${id}`,
    "not a url",
  ]) expect(paneShareIdFromUrl(link)).toBeNull();
});
