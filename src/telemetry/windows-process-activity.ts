import { dlopen, FFIType, ptr } from "bun:ffi";
import type { ProcessActivityReading } from "../utils/stall-process-activity";

function pageFaultReader(): () => ProcessActivityReading["pageFaults"] {
  try {
    if (process.arch !== "x64" && process.arch !== "arm64") return () => undefined;
    const { symbols } = dlopen("kernel32.dll", {
      GetCurrentProcess: { args: [], returns: FFIType.u64 },
      K32GetProcessMemoryInfo: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    const processHandle = symbols.GetCurrentProcess();
    const counters = new Uint32Array(new BigUint64Array(9).buffer);
    counters[0] = counters.byteLength;
    const buffer = ptr(counters);
    return () => symbols.K32GetProcessMemoryInfo(processHandle, buffer, counters.byteLength) ? BigInt(counters[1]!) : null;
  } catch {
    return () => undefined;
  }
}

function ioReader(): () => ProcessActivityReading["io"] {
  try {
    const { symbols } = dlopen("kernel32.dll", {
      GetCurrentProcess: { args: [], returns: FFIType.u64 },
      GetProcessIoCounters: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    });
    const processHandle = symbols.GetCurrentProcess();
    const counters = new BigUint64Array(6);
    const buffer = ptr(counters);
    return () => symbols.GetProcessIoCounters(processHandle, buffer) ? Array.from(counters) : null;
  } catch {
    return () => undefined;
  }
}

/** PROCESS_MEMORY_COUNTERS (total faults) and IO_COUNTERS (all process I/O, not physical disk activity). */
export function createWindowsProcessActivity(): () => ProcessActivityReading {
  const pageFaults = pageFaultReader();
  const io = ioReader();
  return () => ({ pageFaults: pageFaults(), io: io() });
}
