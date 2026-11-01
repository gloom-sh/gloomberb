import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { createPluginCache } from "../../../data/plugin-cache";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { loadCloudResource, unavailableOnServer } from "./cloud-resource";

const policy = { staleMs: 60_000, expireMs: 600_000 };

// Two tabs that read one key share its request. Leaving the first while it
// loads aborts that request; the tab still waiting must load, not fail.
test("a caller whose shared request was aborted by another caller loads again", async () => {
  const cache = createPluginCache<string>({ kind: "shared-abort", source: "test", policy });
  let calls = 0;
  const fetchFor = (signal: AbortSignal) => () => {
    calls += 1;
    return new Promise<string>((resolve, reject) => {
      if (calls > 1) return resolve("board");
      if (signal.aborted) return reject(new DOMException("The operation was aborted.", "AbortError"));
      signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
    });
  };
  const first = new AbortController();
  const second = new AbortController();
  const leaving = loadCloudResource(cache, "loads", fetchFor(first.signal), { signal: first.signal });
  const staying = loadCloudResource(cache, "loads", fetchFor(second.signal), { signal: second.signal });
  first.abort();

  await expect(leaving).rejects.toMatchObject({ name: "AbortError" });
  expect((await staying).payload).toBe("board");
  expect(calls).toBe(2);
});

// The copy answered a failed refresh with no note when the failure had no message, and covered
// refusals asking again would not change (a series the server no longer serves) with old data.
test("a saved copy is said by where it came from, and a refusal or a malformed reply is said instead of covered", async () => {
  const cache = createPluginCache<string>({ kind: "saved-flag", source: "test", policy });
  cache.attach(new MemoryPluginPersistence());
  expect(await loadCloudResource(cache, "board", async () => "board")).toEqual({ payload: "board", stale: false, refreshError: null });

  const silent = await loadCloudResource(cache, "board", async () => { throw Object.assign(new Error(""), { code: "ECONNRESET" }); }, { force: true });
  expect(silent).toMatchObject({ payload: "board", stale: true, savedAt: expect.any(Number) });

  // A route the server stopped serving keeps its status through `unavailableOnServer`, so it is said too.
  const stopped = unavailableOnServer(new ApiRequestError("Not found", 404), "Board not available yet");
  for (const refused of [new ApiRequestError("Refused", 400), new ApiRequestError("Refused", 403), stopped, new Error("Invalid board")]) {
    await expect(loadCloudResource(cache, "board", async () => { throw refused; }, { force: true })).rejects.toBe(refused);
  }
  expect(stopped).toMatchObject({ message: "Board not available yet", status: 404 });
  // A timeout, a rate limit or a server error passes with time: the copy answers.
  for (const status of [408, 429, 503]) {
    const passing = await loadCloudResource(cache, "board", async () => { throw new ApiRequestError("Slow down", status); }, { force: true });
    expect(passing.savedAt).toEqual(expect.any(Number));
  }
});
