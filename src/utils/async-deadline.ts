export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: (error: OperationTimeoutError) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new OperationTimeoutError(message);
      reject(error);
      onTimeout?.(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * The promise's value, or null once it rejects or `timeoutMs` passes. For
 * optional sources that must neither fail nor hold up the caller.
 */
export function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/** The error fetch and other cancellable work reject with once aborted. */
export function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

/**
 * Settles with the promise, or rejects with an AbortError carrying `message`
 * as soon as the signal fires. The work itself keeps running, so one consumer
 * can stop waiting without cancelling a request it shares with others.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(message));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
