import { afterEach, expect, test } from "bun:test";
import { setHttpFetchTransport } from "../../utils/http-transport";
import { readRegistryOnce } from "./feed";

afterEach(() => setHttpFetchTransport(null));

// An unknown code (a mistyped ticker) waited on the registry's three ten-second attempts, and the
// request outlived the error the command printed.
test("a short registry read is one request, cut off at its deadline", async () => {
  const signals: AbortSignal[] = [];
  setHttpFetchTransport((_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    signals.push(signal);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const started = Date.now();
  await expect(readRegistryOnce(50)).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(signals).toHaveLength(1);
  expect(signals[0]!.aborted).toBe(true);

  const plugin = { id: "hackernews", name: "Hacker News" };
  setHttpFetchTransport(async () => Response.json({ plugins: [plugin] }));
  expect(await readRegistryOnce(50)).toEqual([plugin] as never);
});
