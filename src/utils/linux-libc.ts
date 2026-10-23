/**
 * Which C library a Linux process runs on. The terminal's native render
 * library and the release binary each have a glibc and a musl build, and the
 * wrong one fails to load: the glibc library on Alpine stops at startup with
 * "getcontext: symbol not found".
 */
export type LinuxLibc = "glibc" | "musl";

/**
 * Reads the libraries mapped into the process (`/proc/self/maps`). musl is
 * checked first because a glibc program started through gcompat still runs on
 * musl underneath, and the musl library is the one it can load.
 */
export function libcFromProcessMaps(maps: string): LinuxLibc | null {
  if (maps.includes("/ld-musl-") || maps.includes("/libc.musl-")) return "musl";
  if (maps.includes("/libc.so.6") || maps.includes("/ld-linux-")) return "glibc";
  return null;
}

/** Reads the system's `ldd`, a script that names its C library, for when `/proc` is not mounted. */
export function libcFromLdd(script: string): LinuxLibc | null {
  if (script.includes("musl")) return "musl";
  if (/GNU C Library|glibc/i.test(script)) return "glibc";
  return null;
}

function readText(path: string): string | null {
  try {
    return process.getBuiltinModule("fs").readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

let detected: LinuxLibc | null | undefined;

/** The C library this process runs on, or null off Linux or when nothing says. */
export function detectLinuxLibc(): LinuxLibc | null {
  if (globalThis.process?.platform !== "linux") return null;
  if (detected !== undefined) return detected;
  detected = libcFromProcessMaps(readText("/proc/self/maps") ?? "")
    ?? libcFromLdd(readText("/usr/bin/ldd") ?? "");
  return detected;
}

/**
 * @opentui/core loads its glibc library on Linux unless `OPENTUI_LIBC` says
 * musl; it never looks at the system. Has to run before it is first imported.
 * An `OPENTUI_LIBC` the user set is kept.
 */
export function selectOpenTuiLibc(env: Record<string, string | undefined>, libc: LinuxLibc | null): void {
  if (!env.OPENTUI_LIBC && libc === "musl") env.OPENTUI_LIBC = "musl";
}
