import { dlopen, FFIType, ptr } from "bun:ffi";
import type { StallClockReading } from "../utils/main-thread-stall";

/** macOS `clock_gettime_nsec_np` clocks: awake time (stops in sleep), and this thread's CPU time. */
const DARWIN_CLOCK_UPTIME_RAW = 8;
const DARWIN_CLOCK_THREAD_CPUTIME_ID = 16;
/** Linux `clock_gettime` clocks: awake time (stops in suspend), and this thread's CPU time. */
const LINUX_CLOCK_MONOTONIC = 1;
const LINUX_CLOCK_THREAD_CPUTIME_ID = 3;
/** Windows counts both in 100 ns units. */
const WINDOWS_TICKS_PER_MS = 10_000;

type PlatformClocks = () => Pick<StallClockReading, "awakeMs" | "threadCpuMs">;

function processCpuMs(): number | null {
  if (typeof process.cpuUsage !== "function") return null;
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1_000;
}

/**
 * Windows: QueryUnbiasedInterruptTime leaves out sleep and hibernation (the
 * clock timers read keeps counting through them), and GetThreadTimes gives
 * the calling thread's kernel and user time.
 */
function windowsClocks(): PlatformClocks {
  const kernel32 = dlopen("kernel32.dll", {
    QueryUnbiasedInterruptTime: { args: [FFIType.ptr], returns: FFIType.bool },
    // A handle as a 64-bit integer: the pseudo-handle is -2, which a pointer as a JS number would not keep exactly.
    GetCurrentThread: { args: [], returns: FFIType.u64 },
    GetThreadTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  });
  // A pseudo-handle: whichever thread passes it means itself.
  const thread = kernel32.symbols.GetCurrentThread();
  const awake = new BigUint64Array(1);
  // Creation, exit, kernel and user time.
  const times = new BigUint64Array(4);
  return () => ({
    awakeMs: kernel32.symbols.QueryUnbiasedInterruptTime(ptr(awake)) ? Number(awake[0]!) / WINDOWS_TICKS_PER_MS : null,
    threadCpuMs: thread && kernel32.symbols.GetThreadTimes(thread, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))
      ? Number(times[2]! + times[3]!) / WINDOWS_TICKS_PER_MS
      : null,
  });
}

function darwinClocks(): PlatformClocks {
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    clock_gettime_nsec_np: { args: [FFIType.u32], returns: FFIType.u64 },
  });
  const read = (clock: number): number | null => {
    const nanoseconds = Number(libc.symbols.clock_gettime_nsec_np(clock));
    return nanoseconds > 0 ? nanoseconds / 1e6 : null;
  };
  return () => ({ awakeMs: read(DARWIN_CLOCK_UPTIME_RAW), threadCpuMs: read(DARWIN_CLOCK_THREAD_CPUTIME_ID) });
}

function linuxClocks(): PlatformClocks {
  const libc = dlopen("libc.so.6", {
    clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  // struct timespec: seconds, nanoseconds.
  const time = new BigInt64Array(2);
  const read = (clock: number): number | null => (
    libc.symbols.clock_gettime(clock, ptr(time)) === 0 ? Number(time[0]!) * 1_000 + Number(time[1]!) / 1e6 : null
  );
  return () => ({ awakeMs: read(LINUX_CLOCK_MONOTONIC), threadCpuMs: read(LINUX_CLOCK_THREAD_CPUTIME_ID) });
}

function platformClocks(): PlatformClocks | null {
  try {
    if (process.platform === "win32") return windowsClocks();
    if (process.platform === "darwin") return darwinClocks();
    if (process.platform === "linux") return linuxClocks();
  } catch {
    // Intentional ignore: without the platform's clocks a stall still counts, only its cause stays unknown.
  }
  return null;
}

/**
 * The clocks the stall monitor reads on each check, for the thread that
 * calls this: the thread's CPU time is the caller's own. A platform whose
 * clocks cannot be loaded gives the process's CPU time alone.
 */
export function createStallClocks(): () => StallClockReading {
  const platform = platformClocks();
  return () => ({
    awakeMs: null,
    threadCpuMs: null,
    ...platform?.(),
    processCpuMs: processCpuMs(),
  });
}
