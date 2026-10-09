import { afterEach, expect, test } from "bun:test";
import { createGeoFixtureRequest } from "../test-support/test-fixture-geo";
import { loadGeoCatalog, peekGeoCatalog, resetGeoCatalogCache } from "./geo";

afterEach(() => resetGeoCatalogCache());

test("a server without geo layers reads as none, and is asked again only after a while", async () => {
  const paths: string[] = [];
  const absent = createGeoFixtureRequest({ absent: true, onRequest: (path) => paths.push(path) });
  expect(await loadGeoCatalog(absent, { now: 0 })).toBeNull();
  expect(await loadGeoCatalog(absent, { now: 5 * 60_000 })).toBeNull();
  expect(paths).toEqual(["layers"]);

  const present = createGeoFixtureRequest({ onRequest: (path) => paths.push(path) });
  const catalog = await loadGeoCatalog(present, { now: 11 * 60_000 });
  expect(paths).toEqual(["layers", "layers"]);
  expect(catalog?.layers.map((layer) => layer.id)).toContain("vessels");
  expect(peekGeoCatalog()).toBe(catalog);
  // Static layers carry no refresh cadence even when the server sends zero.
  expect(catalog?.layers.find((layer) => layer.id === "airports")?.refreshSeconds).toBeNull();
});

test("a malformed answer is no catalog, not a crash", async () => {
  const broken = (async () => ({ layers: [{ id: "x" }, null, "y"] })) as Parameters<typeof loadGeoCatalog>[0];
  expect(await loadGeoCatalog(broken)).toBeNull();
});
