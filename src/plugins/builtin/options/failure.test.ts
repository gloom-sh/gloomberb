import { expect, spyOn, test } from "bun:test";
import { debugLog } from "../../../utils/debug-log";
import { loadOpenInterest, type OpenInterestPayload } from "../options-positioning/client";
import { loadListedOpenInterest } from "./open-interest-as-of";

test("a listing that cannot be read leaves the open-interest date unstated and logs no rejection details", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "options.open-interest-as-of") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const listed = await loadListedOpenInterest("ACME", "2026-11-20", {
      api: { optionsPositioning: async () => { throw new Error("token=private https://fixture.invalid/?secret=private"); } },
    });
    expect(listed).toBeNull();
    expect(logged).toEqual([["warn", expect.stringMatching(/^Load listed open interest failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});

test("OMON's deadline ends its own wait, never the open-interest request OPX shares", async () => {
  const payload = { version: 1, symbol: "SHRD", expiry: "2026-11-20" } as unknown as OpenInterestPayload;
  let calls = 0;
  const api = { optionsPositioning: (_path: string, init?: { signal?: AbortSignal }) => {
    calls += 1;
    return new Promise<OpenInterestPayload>((resolve, reject) => {
      // Past OMON's deadline; an abort of this request would fail OPX's load with it.
      const timer = setTimeout(() => resolve(payload), 40);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("The operation was aborted.", "AbortError")); }, { once: true });
    });
  } } as never;
  const omon = loadListedOpenInterest("SHRD", "2026-11-20", { api, timeoutMs: 5 });
  const opx = loadOpenInterest("SHRD", "2026-11-20", { signal: new AbortController().signal }, api);
  expect(await omon).toBeNull();
  expect((await opx).payload).toBe(payload);
  expect(calls).toBe(1);
});
