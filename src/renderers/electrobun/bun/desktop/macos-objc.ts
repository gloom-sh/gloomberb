import { dlopen, FFIType } from "bun:ffi";

const LIBOBJC = "/usr/lib/libobjc.A.dylib";

export type Objc = ReturnType<typeof loadObjc>;

let cachedObjc: Objc | null | undefined;

export const cString = (value: string) => Buffer.from(`${value}\0`);

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

export function objcOrNull(): Objc | null {
  if (process.platform !== "darwin") return null;
  if (cachedObjc !== undefined) return cachedObjc;
  try {
    cachedObjc = loadObjc();
  } catch {
    cachedObjc = null;
  }
  return cachedObjc;
}
