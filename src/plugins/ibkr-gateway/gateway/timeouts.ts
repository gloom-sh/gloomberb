export const IBKR_DATA_TIMEOUT = 8_000;
export const IBKR_PNL_TIMEOUT = 3_000;

/** Wrap a promise with a timeout so that IBKR calls don't hang indefinitely. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`IBKR ${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
