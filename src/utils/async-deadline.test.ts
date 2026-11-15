import { describe, expect, test } from "bun:test";
import { abortable, signalWithTimeout } from "./async-deadline";

/** Like fetch against a server that never answers: settles only when aborted. */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("abortable observes cancelled work failures and preserves active callers' failures", async () => {
  const inputs = new Set<Promise<unknown>>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown, promise: Promise<unknown>) => {
    if (inputs.has(promise)) unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const alreadyAborted of [true, false]) {
      const caller = new AbortController();
      const input = Promise.withResolvers<never>();
      inputs.add(input.promise);
      if (alreadyAborted) caller.abort();
      const waiting = abortable(input.promise, caller.signal, "Stopped waiting");
      caller.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError", message: "Stopped waiting" });
      input.reject(new Error("The cancelled work failed later"));
    }

    const failure = new Error("The active work failed");
    await expect(abortable(Promise.reject(failure), new AbortController().signal, "Stopped waiting"))
      .rejects.toBe(failure);
    await Bun.sleep(0);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

describe("signalWithTimeout", () => {
  test("a request given a caller signal still gives up at the timeout", async () => {
    const caller = new AbortController();
    const error = await hangUntilAborted(signalWithTimeout(caller.signal, 20)).catch((reason) => reason);
    expect((error as DOMException).name).toBe("TimeoutError");
    expect(caller.signal.aborted).toBe(false);
  });

  test("the caller can still cancel before the timeout, with its own reason", async () => {
    const caller = new AbortController();
    const request = hangUntilAborted(signalWithTimeout(caller.signal, 10_000));
    caller.abort(new Error("pane closed"));
    await expect(request).rejects.toThrow("pane closed");
  });
});
