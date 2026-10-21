import { expect, test } from "bun:test";
import { createPluginCache } from "../../../data/plugin-cache";
import { loadCloudResource } from "./cloud-resource";

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
