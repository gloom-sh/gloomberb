import { describe, expect, test } from "bun:test";
import { signalWithTimeout } from "./async-deadline";

/** Like fetch against a server that never answers: settles only when aborted. */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

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
