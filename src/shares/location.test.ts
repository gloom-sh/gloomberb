import { afterEach, expect, test } from "bun:test";
import { isPaneShareHandoff, paneShareIdFromSearch } from "./location";

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
