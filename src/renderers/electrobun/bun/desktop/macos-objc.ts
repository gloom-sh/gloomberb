import { dlopen, FFIType } from "bun:ffi";

const LIBOBJC = "/usr/lib/libobjc.A.dylib";

export type Objc = ReturnType<typeof loadObjc>;

/** An Objective-C object or class as its address, `0n` for nil. */
export type ObjcId = bigint;

let cachedObjc: Objc | null | undefined;

export const cString = (value: string) => Buffer.from(`${value}\0`);

// Objects cross the FFI as u64, never as ptr. Bun hands a ptr result to
// JavaScript as a double, exact only up to 2**53, and Foundation keeps short
// strings and small numbers (a Dock badge label such as "3") in tagged
// pointers whose data sits in the top bits. Through a ptr they come back
// rounded, and the next message to one crashes the process.
const ID = FFIType.u64;

// objc_msgSend has to be called with each method's exact C signature, so it is
// bound once per call shape.
function loadObjc() {
  const runtime = dlopen(LIBOBJC, {
    objc_getClass: { args: [FFIType.ptr], returns: ID },
    sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
  }).symbols;
  const msgSend = <const Args extends FFIType[], Returns extends FFIType>(args: Args, returns: Returns) =>
    dlopen(LIBOBJC, { objc_msgSend: { args: [ID, FFIType.ptr, ...args], returns } }).symbols.objc_msgSend;

  return {
    getClass: (name: string) => runtime.objc_getClass(cString(name)),
    selector: (name: string) => runtime.sel_registerName(cString(name)),
    send: msgSend([], ID),
    sendVoid: msgSend([], FFIType.void),
    sendObject: msgSend([ID], ID),
    sendCString: msgSend([FFIType.ptr], ID),
    sendBytes: msgSend([FFIType.ptr, FFIType.u64], ID),
    sendOnMainThread: msgSend([FFIType.ptr, ID, FFIType.bool], FFIType.void),
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
