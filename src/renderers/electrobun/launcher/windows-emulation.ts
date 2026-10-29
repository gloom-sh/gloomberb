import { dlopen, ptr, read, type Pointer } from "bun:ffi";

// Windows on Arm runs the x64 app under emulation. When a thread exits there,
// Windows' emulation layer can fault on memory it no longer reaches
// (ntdll!RtlEcContextToNativeContext) and recovers from that fault itself.
// Bun 1.3's crash handler is a vectored exception handler, so it sees the
// fault before Windows does and takes it for a crash. On the exiting thread,
// which has no thread-local storage left, the handler then faults inside
// itself until the thread's stack is gone, and the app closes some seconds
// after it opens. Bun 1.4 only claims faults inside its own code. Until the
// app runs on it, remove Bun's handler under emulation and leave faults to
// Windows, which still reports a real crash.

// The Bun build Electrobun ships, by link timestamp, and where that build
// keeps the handle of its vectored exception handler (from its symbols).
const BUN_HANDLER_HANDLES = new Map<number, number>([
  [0x69e4847f, 0x68e3d40], // Bun 1.3.13, bun-windows-x64-baseline
]);

const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
const CURRENT_PROCESS = -1;

export type EmulationFaultsResult = "not emulated" | "other bun build" | "handler already gone" | "handler removed" | "handler not found";

export function leaveEmulationFaultsToWindows(): EmulationFaultsResult {
  const kernel32 = dlopen("kernel32.dll", {
    GetModuleHandleW: { args: ["ptr"], returns: "ptr" },
    IsWow64Process2: { args: ["i64", "ptr", "ptr"], returns: "i32" },
    RemoveVectoredExceptionHandler: { args: ["ptr"], returns: "u32" },
  });
  try {
    const processMachine = new Uint16Array(1);
    const nativeMachine = new Uint16Array(1);
    if (!kernel32.symbols.IsWow64Process2(CURRENT_PROCESS, ptr(processMachine), ptr(nativeMachine))) return "not emulated";
    if (nativeMachine[0] !== IMAGE_FILE_MACHINE_ARM64) return "not emulated";

    const image = kernel32.symbols.GetModuleHandleW(null);
    if (!image) return "other bun build";
    const timestamp = read.u32(image, read.u32(image, 0x3c) + 8);
    const handleOffset = BUN_HANDLER_HANDLES.get(timestamp);
    if (handleOffset === undefined) return "other bun build";

    const handle = read.ptr(image, handleOffset) as Pointer;
    if (!handle) return "handler already gone";
    // Windows only removes a handle it has registered, so a wrong value does nothing.
    return kernel32.symbols.RemoveVectoredExceptionHandler(handle) ? "handler removed" : "handler not found";
  } finally {
    kernel32.close();
  }
}
