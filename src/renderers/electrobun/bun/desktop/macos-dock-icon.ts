import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { appIconColors, appIconSvg } from "../../../../theme/app-icon";
import { getTheme } from "../../../../theme/themes";

const LIBOBJC = "/usr/lib/libobjc.A.dylib";

type Objc = ReturnType<typeof loadObjc>;

let cachedObjc: Objc | null | undefined;
let appliedThemeId: string | null = null;

const cString = (value: string) => Buffer.from(`${value}\0`);

// objc_msgSend has to be called with each method's exact C signature, so it is
// bound once per call shape.
function loadObjc() {
  const runtime = dlopen(LIBOBJC, {
    objc_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
    sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
  }).symbols;
  const msgSend = <const Args extends FFIType[], Returns extends FFIType>(args: Args, returns: Returns) =>
    dlopen(LIBOBJC, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, ...args], returns } }).symbols.objc_msgSend;

  return {
    getClass: (name: string) => runtime.objc_getClass(cString(name)),
    selector: (name: string) => runtime.sel_registerName(cString(name)),
    send: msgSend([], FFIType.ptr),
    sendVoid: msgSend([], FFIType.void),
    sendObject: msgSend([FFIType.ptr], FFIType.ptr),
    sendBytes: msgSend([FFIType.ptr, FFIType.u64], FFIType.ptr),
    sendOnMainThread: msgSend([FFIType.ptr, FFIType.ptr, FFIType.bool], FFIType.void),
  };
}

function objcOrNull(): Objc | null {
  if (process.platform !== "darwin") return null;
  if (cachedObjc !== undefined) return cachedObjc;
  try {
    cachedObjc = loadObjc();
  } catch {
    cachedObjc = null;
  }
  return cachedObjc;
}

function createImage(objc: Objc, svg: string): Pointer | null {
  const bytes = Buffer.from(svg);
  const data = objc.sendBytes(
    objc.send(objc.getClass("NSData"), objc.selector("alloc")),
    objc.selector("initWithBytes:length:"),
    bytes,
    bytes.byteLength,
  );
  if (!data) return null;
  const image = objc.sendObject(
    objc.send(objc.getClass("NSImage"), objc.selector("alloc")),
    objc.selector("initWithData:"),
    data,
  );
  objc.sendVoid(data, objc.selector("release"));
  return image;
}

/**
 * Repaints the Dock icon in the active theme's accent. The bundle icon stays
 * the official mint one, so the Dock shows it again whenever Gloomberb quits.
 */
export function applyMacosDockIcon(themeId: string): void {
  if (themeId === appliedThemeId) return;
  const objc = objcOrNull();
  if (!objc) return;
  appliedThemeId = themeId;

  try {
    // Older macOS versions cannot read SVG images; they keep the bundle icon.
    const image = createImage(objc, appIconSvg(appIconColors(getTheme(themeId))));
    if (!image) return;
    const app = objc.send(objc.getClass("NSApplication"), objc.selector("sharedApplication"));
    // AppKit only takes this on the main thread, and Bun runs on another one.
    objc.sendOnMainThread(
      app,
      objc.selector("performSelectorOnMainThread:withObject:waitUntilDone:"),
      objc.selector("setApplicationIconImage:"),
      image,
      false,
    );
    objc.sendVoid(image, objc.selector("release"));
  } catch (error) {
    console.error("[dock-icon] failed to apply the theme icon", error);
  }
}
