import { expect, spyOn, test } from "bun:test";
import { BROWSER_STORAGE_KEYS, type StorageLike } from "../../data/json-storage";
import { debugLog } from "../../utils/debug-log";
import { createBrowserConfigStore } from "./config-host";

test("a reset that cannot remove a saved key removes the rest and is logged without the error", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "web-config") logged.push([entry.level, entry.message, entry.data]);
  });
  const items = new Map(Object.values(BROWSER_STORAGE_KEYS).map((key) => [key, "saved"]));
  const storage: StorageLike = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); },
    removeItem: (key) => {
      if (key === BROWSER_STORAGE_KEYS.session) throw new Error("token=private portfolio=private");
      items.delete(key);
    },
  };
  try {
    await createBrowserConfigStore(storage).resetAllData("browser://local");
    expect([...items.keys()].sort()).toEqual([BROWSER_STORAGE_KEYS.config, BROWSER_STORAGE_KEYS.session].sort());
    expect(logged).toEqual([["warn", expect.stringMatching(/^Could not remove saved browser data on reset(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
