import { dlopen, FFIType, ptr } from "bun:ffi";
import type { RpcClockSample } from "../utils/rpc-timeout-error";

function createReader(): () => RpcClockSample | null {
  try {
    const { symbols } = dlopen("kernel32.dll", {
      GetTickCount64: { args: [], returns: FFIType.u64 },
      QueryUnbiasedInterruptTime: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    const readings = new BigUint64Array(1);
    const awake = ptr(readings);
    return () => {
      const before = Date.now();
      const elapsedMs = Number(symbols.GetTickCount64());
      if (!symbols.QueryUnbiasedInterruptTime(awake)) return null;
      const wallMs = Date.now();
      if (wallMs < before || wallMs - before > 32) return null;
      return { wallMs, elapsedMs, awakeMs: Number(readings[0]!) / 10_000 };
    };
  } catch {
    return () => null;
  }
}

let read: (() => RpcClockSample | null) | undefined;

/** Time since boot includes sleep; unbiased interrupt time does not. */
export function readWindowsTimeoutClock(): RpcClockSample | null {
  if (process.platform !== "win32") return null;
  read ??= createReader();
  return read();
}
