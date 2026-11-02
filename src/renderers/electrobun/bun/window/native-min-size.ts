import { cc, dlopen, FFIType, type Pointer } from "bun:ffi";
import { createHash } from "crypto";
import { existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { logFailure } from "../../../../utils/log-failure";
import { cString, objcOrNull } from "../desktop/macos-objc";
import type { WindowMinimumSize } from "./frame";

/**
 * Electrobun has no minimum window size (2.0.5 neither), so the app shrank
 * under it at every resize and jumped back once the resize event came. Here
 * each system holds the window to it while it is being resized:
 *
 * - macOS: `NSWindow.contentMinSize`.
 * - Windows: the window's `WM_GETMINMAXINFO` answer, by a window procedure
 *   placed before Electrobun's that raises its minimum tracking size to this
 *   one, at the window's DPI.
 * - Linux: GTK's geometry hints, which the window manager reads.
 *
 * The app's code runs on a thread of its own, not the one the windows belong
 * to, so each change is handed to that thread: AppKit's
 * `performSelectorOnMainThread:`, GLib's main loop. A Windows window procedure
 * runs on the window's thread and has to answer there and then, which is why
 * Windows and Linux use a few lines of C compiled at runtime (Bun's `cc`).
 *
 * The snap back in events.ts stays as the fallback for a system where this
 * does not apply.
 */

/** The C the Windows window procedure is made of. Pointer-sized integers are `long long`: `long` is 32-bit there. */
const WINDOWS_SOURCE = String.raw`
typedef long long sptr;
typedef unsigned long long uptr;
typedef void *HWND;
typedef sptr (*WNDPROC)(HWND, unsigned int, uptr, sptr);
typedef struct { int x; int y; } Pt;
typedef struct { Pt reserved; Pt max_size; Pt max_position; Pt min_track; Pt max_track; } MinMaxInfo;

#define WM_GETMINMAXINFO 0x0024
#define WM_NCDESTROY 0x0082
#define GWLP_WNDPROC (-4)
#define SLOTS 64

typedef struct { HWND volatile hwnd; WNDPROC volatile previous; int volatile width; int volatile height; } Slot;

static Slot slots[SLOTS];
static sptr (*call_window_proc)(WNDPROC, HWND, unsigned int, uptr, sptr);
static sptr (*get_window_long_ptr)(HWND, int);
static sptr (*set_window_long_ptr)(HWND, int, sptr);
static sptr (*def_window_proc)(HWND, unsigned int, uptr, sptr);
static unsigned int (*get_dpi_for_window)(HWND);

static Slot *slot_of(HWND hwnd) {
  for (int i = 0; i < SLOTS; i++) if (slots[i].hwnd == hwnd) return &slots[i];
  return 0;
}

static sptr min_size_proc(HWND hwnd, unsigned int message, uptr wparam, sptr lparam) {
  Slot *slot = slot_of(hwnd);
  WNDPROC previous = slot ? slot->previous : 0;
  if (!previous) return def_window_proc(hwnd, message, wparam, lparam);
  if (message == WM_NCDESTROY) {
    set_window_long_ptr(hwnd, GWLP_WNDPROC, (sptr)previous);
    slot->hwnd = 0;
    return call_window_proc(previous, hwnd, message, wparam, lparam);
  }
  sptr result = call_window_proc(previous, hwnd, message, wparam, lparam);
  if (message == WM_GETMINMAXINFO && lparam) {
    MinMaxInfo *info = (MinMaxInfo *)lparam;
    int dpi = get_dpi_for_window ? (int)get_dpi_for_window(hwnd) : 0;
    if (dpi <= 0) dpi = 96;
    int width = (slot->width * dpi + 48) / 96;
    int height = (slot->height * dpi + 48) / 96;
    if (info->min_track.x < width) info->min_track.x = width;
    if (info->min_track.y < height) info->min_track.y = height;
  }
  return result;
}

int gloom_min_size_init(void *call, void *get_long, void *set_long, void *def, void *dpi) {
  call_window_proc = (sptr (*)(WNDPROC, HWND, unsigned int, uptr, sptr))call;
  get_window_long_ptr = (sptr (*)(HWND, int))get_long;
  set_window_long_ptr = (sptr (*)(HWND, int, sptr))set_long;
  def_window_proc = (sptr (*)(HWND, unsigned int, uptr, sptr))def;
  get_dpi_for_window = (unsigned int (*)(HWND))dpi;
  return call && get_long && set_long && def;
}

/* 1 when the window had a minimum already and now has this one, 2 when it is newly held to it, 0 when it cannot be. */
int gloom_min_size_set(HWND hwnd, int width, int height) {
  Slot *slot = slot_of(hwnd);
  if (slot) {
    slot->width = width;
    slot->height = height;
    return 1;
  }
  for (int i = 0; i < SLOTS && !slot; i++) if (!slots[i].hwnd) slot = &slots[i];
  if (!slot) return 0;
  sptr current = get_window_long_ptr(hwnd, GWLP_WNDPROC);
  if (!current) return 0;
  slot->width = width;
  slot->height = height;
  slot->previous = (WNDPROC)current;
  /* Taken only once the procedure it hands on to is in place. */
  slot->hwnd = hwnd;
  sptr replaced = set_window_long_ptr(hwnd, GWLP_WNDPROC, (sptr)min_size_proc);
  if (!replaced) {
    slot->hwnd = 0;
    return 0;
  }
  if (replaced != current) slot->previous = (WNDPROC)replaced;
  return 2;
}
`;

/** The C that hands a GTK window's minimum size to GLib's main loop. */
const LINUX_SOURCE = String.raw`
typedef struct {
  int min_width; int min_height; int max_width; int max_height;
  int base_width; int base_height; int width_inc; int height_inc;
  double min_aspect; double max_aspect; int win_gravity;
} Geometry;

#define GDK_HINT_MIN_SIZE 2
#define SLOTS 64

typedef struct { void *volatile window; Geometry geometry; } Request;

static Request requests[SLOTS];
static unsigned int next_request;
static unsigned int (*idle_add)(int (*)(void *), void *);
static void (*set_geometry_hints)(void *, void *, Geometry *, int);
static void *(*object_ref)(void *);
static void (*object_unref)(void *);

static int apply(void *data) {
  Request *request = (Request *)data;
  void *window = request->window;
  if (window) {
    set_geometry_hints(window, 0, &request->geometry, GDK_HINT_MIN_SIZE);
    request->window = 0;
    object_unref(window);
  }
  return 0;
}

int gloom_min_size_init(void *idle, void *hints, void *ref, void *unref) {
  idle_add = (unsigned int (*)(int (*)(void *), void *))idle;
  set_geometry_hints = (void (*)(void *, void *, Geometry *, int))hints;
  object_ref = (void *(*)(void *))ref;
  object_unref = (void (*)(void *))unref;
  return idle && hints && ref && unref;
}

int gloom_min_size_set(void *window, int width, int height) {
  Request *request = &requests[next_request++ % SLOTS];
  if (request->window) return 0;
  request->geometry.min_width = width;
  request->geometry.min_height = height;
  request->window = object_ref(window);
  idle_add(apply, request);
  return 2;
}
`;

const MIN_SIZE_SYMBOLS = {
  gloom_min_size_set: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const;

type MinSizeSetter = (window: Pointer, width: number, height: number) => number;

/** The compiled helper for this system, once; `null` when it could not be made. */
let compiledSetter: MinSizeSetter | null | undefined;
/** The compiled code, kept for good: a window procedure in it runs for as long as its window does. */
const compiledLibraries: unknown[] = [];

/** Writes `source` where `cc` can read it: a file named after its content, so one never changes under another app. */
function sourceFile(source: string): string {
  const path = join(tmpdir(), `gloom-native-min-size-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.c`);
  if (!existsSync(path)) writeFileSync(path, source);
  return path;
}

function windowsSetter(): MinSizeSetter | null {
  const kernel32 = dlopen("kernel32.dll", {
    GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr },
    GetProcAddress: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  }).symbols;
  const user32 = kernel32.GetModuleHandleW(Buffer.from("user32.dll\0", "utf16le"));
  if (!user32) return null;
  const proc = (name: string) => kernel32.GetProcAddress(user32, cString(name));
  const library = cc({
    source: sourceFile(WINDOWS_SOURCE),
    symbols: {
      ...MIN_SIZE_SYMBOLS,
      gloom_min_size_init: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    },
  });
  const ready = library.symbols.gloom_min_size_init(
    proc("CallWindowProcW"),
    proc("GetWindowLongPtrW"),
    proc("SetWindowLongPtrW"),
    proc("DefWindowProcW"),
    proc("GetDpiForWindow"),
  );
  if (!ready) return null;
  compiledLibraries.push(library);
  return library.symbols.gloom_min_size_set;
}

/** The address of `name` in the already loaded library `file`, or null. */
function linuxSymbol(file: string, name: string): Pointer | null {
  for (const libc of ["libc.so.6", "libdl.so.2"]) {
    try {
      const dl = dlopen(libc, {
        dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
        dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      }).symbols;
      // RTLD_LAZY | RTLD_NOLOAD: the library GTK's windows already use, never a second one.
      const handle = dl.dlopen(cString(file), 0x1 | 0x4);
      return handle ? dl.dlsym(handle, cString(name)) : null;
    } catch {
      // No dlopen in this libc: glibc before 2.34 keeps it in libdl.
    }
  }
  return null;
}

function linuxSetter(): MinSizeSetter | null {
  const idleAdd = linuxSymbol("libglib-2.0.so.0", "g_idle_add");
  const geometryHints = linuxSymbol("libgtk-3.so.0", "gtk_window_set_geometry_hints");
  const ref = linuxSymbol("libgobject-2.0.so.0", "g_object_ref");
  const unref = linuxSymbol("libgobject-2.0.so.0", "g_object_unref");
  if (!idleAdd || !geometryHints || !ref || !unref) return null;
  const library = cc({
    source: sourceFile(LINUX_SOURCE),
    symbols: {
      ...MIN_SIZE_SYMBOLS,
      gloom_min_size_init: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    },
  });
  if (!library.symbols.gloom_min_size_init(idleAdd, geometryHints, ref, unref)) return null;
  compiledLibraries.push(library);
  return library.symbols.gloom_min_size_set;
}

function compiledMinSizeSetter(platform: NodeJS.Platform): MinSizeSetter | null {
  if (compiledSetter !== undefined) return compiledSetter;
  try {
    compiledSetter = platform === "win32" ? windowsSetter() : platform === "linux" ? linuxSetter() : null;
  } catch (error) {
    logFailure("desktop-window", "Could not make the native minimum window size")(error);
    compiledSetter = null;
  }
  return compiledSetter;
}

/** Sets an NSWindow's `contentMinSize` on the main thread, through key-value coding, which takes the size boxed. */
function setMacosContentMinSize(window: Pointer, size: WindowMinimumSize): boolean {
  const objc = objcOrNull();
  if (!objc) return false;
  return objc.withAutoreleasePool(() => {
    const value = objc.sendDoubles(objc.getClass("NSValue"), objc.selector("valueWithSize:"), size.width, size.height);
    const key = objc.sendCString(objc.getClass("NSString"), objc.selector("stringWithUTF8String:"), cString("contentMinSize"));
    const values = objc.sendObjects(objc.getClass("NSDictionary"), objc.selector("dictionaryWithObject:forKey:"), value, key);
    if (!values) return false;
    // Retained by the call until it has run on the main thread.
    objc.sendOnMainThread(
      BigInt(window),
      objc.selector("performSelectorOnMainThread:withObject:waitUntilDone:"),
      objc.selector("setValuesForKeysWithDictionary:"),
      values,
      false,
    );
    return true;
  });
}

/** Holds the native window `ptr` to `size` (in the window frame's points) while it is resized. Resolves whether it took. */
function setNativeMinimumSize(ptr: Pointer, size: WindowMinimumSize, platform: NodeJS.Platform = process.platform): boolean {
  const width = Math.ceil(size.width);
  const height = Math.ceil(size.height);
  try {
    if (platform === "darwin") return setMacosContentMinSize(ptr, { width, height });
    const set = compiledMinSizeSetter(platform);
    return set ? set(ptr, width, height) > 0 : false;
  } catch (error) {
    logFailure("desktop-window", "Could not set the native minimum window size")(error);
    return false;
  }
}

const HANDLE_ATTEMPTS = 20;
const HANDLE_RETRY_MS = 100;

/**
 * `setNativeMinimumSize` for a window just opened, once its native window
 * exists: Electrobun may make it after the constructor returns.
 */
export function applyNativeMinimumSize(window: { ptr: Pointer | null }, size: WindowMinimumSize): void {
  let attempts = 0;
  const attempt = () => {
    const handle = window.ptr;
    if (handle) {
      setNativeMinimumSize(handle, size);
      return;
    }
    attempts += 1;
    if (attempts < HANDLE_ATTEMPTS) setTimeout(attempt, HANDLE_RETRY_MS);
  };
  attempt();
}
