import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readDesktopViewIds, saveDesktopViewIds } from "../bun/desktop/view-ids";
import type { DesktopViewIds } from "../shared/protocol";
import { createViewIdMirror, restoreViewIds } from "./view-ids";

// The copy on disk is what a build under a new bundle identifier starts from,
// with WebView storage that is empty: it must come back whole, never replace
// what the storage has, and stay current without a save at every call.
let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "gloom-view-ids-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function memoryStorage(entries: Record<string, string> = {}) {
  const items = new Map(Object.entries(entries));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
  };
}

const ids = {
  "gloomberb.sync.clientId": "client_7b0c6f1e",
  "gloomberb.web.anonymous-id": "0f9d5c1a-58a4-4b6e-9a31-2c1d2b7e8f00",
  "gloomberb.web.attribution": JSON.stringify({ first_touch_at: "2026-10-01T00:00:00.000Z", utm_source: "x" }),
};

test("the ids a view kept come back into the empty storage of a build under a new identifier", async () => {
  const before = memoryStorage({ ...ids, "gloomberb.web.install-id": "not one of them" });
  const mirror = createViewIdMirror(before, readDesktopViewIds(dataDir), async (sent) => saveDesktopViewIds(dataDir, sent));
  mirror();
  await Promise.resolve();

  const after = memoryStorage();
  restoreViewIds(after, readDesktopViewIds(dataDir));
  expect(Object.fromEntries(after.items)).toEqual(ids);
});

test("restoring keeps what the storage has and takes only the view's own keys", () => {
  const storage = memoryStorage({ "gloomberb.sync.clientId": "client_current" });
  restoreViewIds(storage, { ...ids, "gloomberb.other": "x" });
  expect(Object.fromEntries(storage.items)).toEqual({ ...ids, "gloomberb.sync.clientId": "client_current" });
});

test("the mirror saves only a change, and again after a save that failed", async () => {
  const storage = memoryStorage(ids);
  const saves: DesktopViewIds[] = [];
  let fail = true;
  const mirror = createViewIdMirror(storage, ids, async (sent) => {
    saves.push(sent);
    if (fail) throw new Error("disk full");
  });

  mirror();
  expect(saves).toHaveLength(0);

  storage.setItem("gloomberb.web.anonymous-id", "11111111-2222-4333-8444-555555555555");
  mirror();
  await Promise.resolve();
  fail = false;
  mirror();
  mirror();
  await Promise.resolve();
  expect(saves).toHaveLength(2);
  expect(saves[1]?.["gloomberb.web.anonymous-id"]).toBe("11111111-2222-4333-8444-555555555555");
});

test("a copy on disk that does not read, or holds anything else, gives nothing back", () => {
  writeFileSync(join(dataDir, "desktop-view-ids.json"), "{\"gloomberb.sync.clientId\":");
  expect(readDesktopViewIds(dataDir)).toEqual({});
  saveDesktopViewIds(dataDir, { "gloomberb.sync.clientId": 42, "../escape": "x", "gloomberb.web.anonymous-id": "a".repeat(5000) });
  expect(readDesktopViewIds(dataDir)).toEqual({});
});
