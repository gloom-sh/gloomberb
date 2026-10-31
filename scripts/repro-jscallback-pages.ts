// Diagnostic only (Windows): where bun:ffi puts a JSCallback's code, and
// whether those pages stay executable while the process allocates.
import { dlopen, FFIType, JSCallback, ptr, read } from "bun:ffi";

const k32 = dlopen("kernel32.dll", {
  VirtualQuery: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
  GetProcessHeap: { args: [], returns: FFIType.ptr },
  GetProcessHeaps: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
  HeapWalk: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  HeapLock: { args: [FFIType.ptr], returns: FFIType.bool },
  HeapUnlock: { args: [FFIType.ptr], returns: FFIType.bool },
});

type Page = { allocationBase: number; base: number; size: number; state: number; protect: number; type: number };
const mbi = new Uint8Array(48);
function query(address: number): Page {
  k32.symbols.VirtualQuery(address, ptr(mbi), 48n);
  const view = new DataView(mbi.buffer);
  return {
    base: Number(view.getBigUint64(0, true)),
    allocationBase: Number(view.getBigUint64(8, true)),
    size: Number(view.getBigUint64(24, true)),
    state: view.getUint32(32, true),
    protect: view.getUint32(36, true),
    type: view.getUint32(40, true),
  };
}
const hex = (n: number) => `0x${n.toString(16)}`;

// The process heap's regions (segments), to see whether the code is in one.
function heapRegions(heap: number) {
  const regions: Array<[number, number]> = [];
  const entry = new Uint8Array(48);
  const view = new DataView(entry.buffer);
  k32.symbols.HeapLock(heap);
  try {
    while (k32.symbols.HeapWalk(heap, ptr(entry))) {
      const flags = view.getUint16(14, true);
      if (flags & 0x0001) {
        // PROCESS_HEAP_REGION: lpData is the region start; committed + uncommitted sizes follow.
        const start = Number(view.getBigUint64(0, true));
        const committed = view.getUint32(16, true);
        const uncommitted = view.getUint32(20, true);
        regions.push([start, start + committed + uncommitted]);
      }
    }
  } finally {
    k32.symbols.HeapUnlock(heap);
  }
  return regions;
}

const heap = Number(k32.symbols.GetProcessHeap());
const heaps = new BigUint64Array(64);
const heapCount = k32.symbols.GetProcessHeaps(64, ptr(heaps));
console.log(`process heap ${hex(heap)}; ${heapCount} heaps: ${[...heaps.slice(0, heapCount)].map((h) => hex(Number(h))).join(" ")}`);

const callbacks: JSCallback[] = [];
for (let i = 0; i < 40; i++) {
  callbacks.push(new JSCallback(() => {}, { args: [FFIType.u32, FFIType.cstring], returns: FFIType.void, threadsafe: true }));
}
const regions = heapRegions(heap);
console.log(`process heap regions: ${regions.map(([a, b]) => `${hex(a)}-${hex(b)}`).join(" ")}`);
for (const cb of callbacks.slice(0, 6)) {
  const page = query(cb.ptr as unknown as number);
  const inHeap = regions.some(([a, b]) => page.base >= a && page.base < b);
  console.log(`callback ${hex(cb.ptr as unknown as number)}: allocation ${hex(page.allocationBase)} region ${hex(page.base)}+${hex(page.size)} protect ${hex(page.protect)} in process heap: ${inHeap}`);
}

// Churn: allocations of many sizes, libraries opened and closed, callbacks
// made and closed, and see whether any kept callback page stops being executable.
const EXEC = 0x10 | 0x20 | 0x40 | 0x80;
const lost = new Set<number>();
const started = performance.now();
let round = 0;
const keep: unknown[] = [];
while (performance.now() - started < Number(process.env.CHURN_MS ?? 60_000)) {
  round += 1;
  for (let i = 0; i < 200; i++) keep.push(new Uint8Array(1 + ((i * 7919) % 70_000)));
  for (let i = 0; i < 50; i++) keep.push("x".repeat((i * 104729) % 20_000) + round);
  if (keep.length > 5_000) keep.splice(0, 2_500);
  if (round % 5 === 0) {
    const lib = dlopen("kernel32.dll", { GetTickCount: { args: [], returns: FFIType.u32 }, GetCurrentProcessId: { args: [], returns: FFIType.u32 } });
    lib.symbols.GetTickCount();
    lib.close();
  }
  if (round % 7 === 0) {
    const temp = new JSCallback(() => {}, { args: [FFIType.u32], returns: FFIType.void });
    temp.close();
  }
  if (round % 3 === 0) Bun.gc(false);
  for (const cb of callbacks) {
    const address = cb.ptr as unknown as number;
    if (lost.has(address)) continue;
    const page = query(address);
    if (!(page.protect & EXEC)) {
      lost.add(address);
      console.log(`round ${round} at ${Math.round(performance.now() - started)} ms: callback ${hex(address)} page is now protect ${hex(page.protect)} state ${hex(page.state)} region ${hex(page.base)}+${hex(page.size)}`);
    }
  }
  await Bun.sleep(1);
}
console.log(`${round} rounds; ${lost.size} of ${callbacks.length} callback pages stopped being executable`);
void read;
