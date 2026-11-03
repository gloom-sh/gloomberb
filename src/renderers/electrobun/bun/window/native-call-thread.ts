import { debugLog } from "../../../../utils/debug-log";

const threadLog = debugLog.createLogger("native-call-thread");

/**
 * Runs on a thread of its own: opens the library once, then makes each call
 * it is sent, one at a time and in order, saying when each starts and ends.
 * The bytes stay alive in the message until the call returns.
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
    postMessage({ type: "started", id: message.id });
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

/**
 * Why the thread stopped taking calls: the library would not open on it, the
 * thread ended, or a call ran past `callLimitMs` and everything behind it
 * would have waited for good.
 */
export type NativeCallThreadFailure = "open-failed" | "ended" | "stuck";

/** A call the thread took and never began. */
export interface UnstartedNativeCall {
  /** When it was taken (performance.now()). */
  takenAt: number;
  /** What the caller gave `call` to make it another way. */
  replay(): void;
}

export interface NativeCallThreadOptions {
  /** Each call that returned, and how long it took. */
  onCallDone?(ms: number): void;
  /**
   * The thread takes no more calls. `unstarted`: those it took and never
   * began, oldest first, for the caller to make another way. A call that
   * began and had not returned is not among them: it may be showing.
   */
  onFailure?(failure: NativeCallThreadFailure, unstarted: UnstartedNativeCall[]): void;
  /** A call running this long counts the thread as stuck. */
  callLimitMs?: number;
}

export interface NativeCallThread {
  /**
   * Queues `symbol(bytes, pointer)` and returns at once. False when the
   * thread cannot take it, and the caller makes the call itself; `replay`
   * makes it another way if the thread stops before beginning it.
   */
  call(bytes: Uint8Array, pointer: number | null, replay: () => void): boolean;
  close(): void;
}

interface WorkerMessage {
  type: "ready" | "failed" | "started" | "done";
  id?: number;
  ms?: number;
  message?: string;
}

interface OwedCall extends UnstartedNativeCall {
  started: boolean;
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
  let stopped = false;
  let nextId = 1;
  const owed = new Map<number, OwedCall>();
  let stuckTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStuckTimer = () => {
    if (stuckTimer) clearTimeout(stuckTimer);
    stuckTimer = null;
  };

  const stop = () => {
    stopped = true;
    clearStuckTimer();
    try {
      // A thread inside a native call ends once the call returns.
      worker.terminate();
    } catch {
      // Intentional ignore: a thread that cannot be stopped is already gone.
    }
    URL.revokeObjectURL(source);
  };

  const fail = (failure: NativeCallThreadFailure, reason: string) => {
    if (stopped) return;
    const unstarted = [...owed.values()].filter((call) => !call.started).map(({ takenAt, replay }) => ({ takenAt, replay }));
    threadLog.warn("The thread for native calls stopped", { failure, reason, unstarted: unstarted.length, running: owed.size - unstarted.length });
    owed.clear();
    stop();
    options.onFailure?.(failure, unstarted);
  };

  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (message.type === "failed") {
      if (message.id === undefined) {
        fail("open-failed", message.message ?? "could not open the library");
        return;
      }
      owed.delete(message.id);
      clearStuckTimer();
      threadLog.warn("A native call failed on its thread", { message: message.message });
      return;
    }
    if (message.type === "started" && message.id !== undefined) {
      const call = owed.get(message.id);
      if (call) call.started = true;
      const limitMs = options.callLimitMs;
      if (limitMs !== undefined) {
        clearStuckTimer();
        stuckTimer = setTimeout(() => fail("stuck", `a call ran past ${limitMs} ms`), limitMs);
        (stuckTimer as { unref?: () => void }).unref?.();
      }
      return;
    }
    if (message.type === "done" && message.id !== undefined) {
      owed.delete(message.id);
      clearStuckTimer();
      options.onCallDone?.(message.ms ?? 0);
    }
  };
  worker.onerror = (event) => {
    fail("ended", event instanceof ErrorEvent ? event.message : "the thread failed");
  };
  worker.addEventListener("close", () => fail("ended", "the thread ended"));

  try {
    worker.postMessage({ type: "open", library, symbol });
  } catch (error) {
    stop();
    threadLog.warn("Could not start a thread for native calls", { error: String(error) });
    return null;
  }

  return {
    call(bytes, pointer, replay) {
      if (stopped) return false;
      const id = nextId++;
      try {
        worker.postMessage({ type: "call", id, bytes, pointer });
      } catch (error) {
        fail("ended", error instanceof Error ? error.message : String(error));
        return false;
      }
      owed.set(id, { takenAt: performance.now(), replay, started: false });
      return true;
    },
    close() {
      if (stopped) return;
      owed.clear();
      stop();
    },
  };
}
