import { debugLog } from "../../../../utils/debug-log";

const threadLog = debugLog.createLogger("native-call-thread");

/**
 * Runs on a thread of its own: opens the library once, then makes each call
 * it is sent, one at a time and in order. The bytes stay alive in the
 * message until the call returns.
 */
const WORKER_SOURCE = `
import { dlopen, ptr } from "bun:ffi";
let call = null;
self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "open") {
    try {
      call = dlopen(message.library, { [message.symbol]: { args: ["ptr", "ptr"], returns: "void" } }).symbols[message.symbol];
      postMessage({ type: "ready" });
    } catch (error) {
      postMessage({ type: "failed", message: String(error && error.message || error) });
    }
    return;
  }
  if (message.type === "call") {
    if (!call) return;
    const startedAt = performance.now();
    try {
      call(ptr(message.bytes), message.pointer || null);
      postMessage({ type: "done", id: message.id, ms: performance.now() - startedAt });
    } catch (error) {
      postMessage({ type: "failed", id: message.id, message: String(error && error.message || error) });
    }
  }
};
`;

export interface NativeCallThreadOptions {
  /** Each call that returned, and how long it took. */
  onCallDone?(ms: number): void;
  /** The thread cannot make calls any more; calls it had not made are dropped. */
  onFailure?(reason: string): void;
}

export interface NativeCallThread {
  /**
   * Queues `symbol(bytes, pointer)` and returns at once. False when the
   * thread cannot take it, and the caller makes the call itself.
   */
  call(bytes: Uint8Array, pointer: number | null): boolean;
  close(): void;
}

interface WorkerMessage {
  type: "ready" | "failed" | "done";
  id?: number;
  ms?: number;
  message?: string;
}

/**
 * A native call that can wait on another thread for as long as a person
 * takes, made from a thread of its own so this one keeps running. On
 * Windows, Electrobun's native calls wait for the thread that runs the
 * windows to answer them, and that thread answers a context menu's only
 * once the menu closes: made here, the app froze for as long as a menu
 * was open.
 *
 * `symbol` takes a pointer to the bytes and one pointer. Null where there is
 * no Worker to run it on.
 */
export function startNativeCallThread(
  library: string,
  symbol: string,
  options: NativeCallThreadOptions = {},
): NativeCallThread | null {
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const source = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(source);
  } catch (error) {
    threadLog.warn("Could not start a thread for native calls", { error: String(error) });
    URL.revokeObjectURL(source);
    return null;
  }
  (worker as { unref?: () => void }).unref?.();
  let failed = false;
  let nextId = 1;
  const owed = new Set<number>();

  const fail = (reason: string) => {
    if (failed) return;
    failed = true;
    threadLog.warn("The thread for native calls stopped", { reason, dropped: owed.size });
    owed.clear();
    try {
      worker.terminate();
    } catch {
      // Intentional ignore: a thread that cannot be stopped is already gone.
    }
    URL.revokeObjectURL(source);
    options.onFailure?.(reason);
  };

  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (message.type === "failed") {
      if (message.id === undefined) {
        fail(message.message ?? "could not open the library");
        return;
      }
      owed.delete(message.id);
      threadLog.warn("A native call failed on its thread", { message: message.message });
      return;
    }
    if (message.type === "done" && message.id !== undefined) {
      owed.delete(message.id);
      options.onCallDone?.(message.ms ?? 0);
    }
  };
  worker.onerror = (event) => {
    fail(event instanceof ErrorEvent ? event.message : "the thread ended");
  };

  try {
    worker.postMessage({ type: "open", library, symbol });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return null;
  }

  return {
    call(bytes, pointer) {
      if (failed) return false;
      const id = nextId++;
      try {
        worker.postMessage({ type: "call", id, bytes, pointer });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return false;
      }
      owed.add(id);
      return true;
    },
    close() {
      if (failed) return;
      failed = true;
      owed.clear();
      worker.terminate();
      URL.revokeObjectURL(source);
    },
  };
}
