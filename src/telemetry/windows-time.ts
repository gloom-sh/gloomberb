import { dlopen, FFIType, ptr } from "bun:ffi";
import type { RpcClockSample } from "../utils/rpc-timeout-error";

function createReader(): () => RpcClockSample | null {
  try {
    const { symbols } = dlopen("kernel32.dll", {
      QueryInterruptTime: { args: [FFIType.ptr], returns: FFIType.void },
      QueryUnbiasedInterruptTime: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    const readings = new BigUint64Array(2);
    const elapsed = ptr(readings);
    const awake = ptr(readings, 8);
    return () => {
      const before = Date.now();
      symbols.QueryInterruptTime(elapsed);
      if (!symbols.QueryUnbiasedInterruptTime(awake)) return null;
      const wallMs = Date.now();
      if (wallMs < before || wallMs - before > 32) return null;
      return { wallMs, elapsedMs: Number(readings[0]!) / 10_000, awakeMs: Number(readings[1]!) / 10_000 };
    };
  } catch {
    return () => null;
  }
}

let read: (() => RpcClockSample | null) | undefined;

/** Interrupt time includes sleep; unbiased interrupt time does not. */
export function readWindowsTimeoutClock(): RpcClockSample | null {
  if (process.platform !== "win32") return null;
  read ??= createReader();
  return read();
}
