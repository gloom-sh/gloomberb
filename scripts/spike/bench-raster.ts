import { join, resolve } from "path";
import { mkdir, writeFile } from "fs/promises";
import { reviveRasterInputs, runRasterBench } from "../../src/components/chart/composite/raster-bench";
import { RASTER_KERNEL_BYTES, RASTER_KERNEL_SHA256, RASTER_KERNEL_SIMD } from "../../src/components/chart/composite/raster-kernel.generated";

/**
 *   bun scripts/spike/bench-raster.ts --panels <panels.json> [--iterations 25] [--out <dir>]
 *
 * The composite chart raster, TypeScript against the WebAssembly kernel, in
 * Bun (the runtime of the terminal app and the desktop backend), on panels a
 * real layout drew (scripts/spike/profile-heavy.ts --capture writes them).
 */
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const panelsPath = option("--panels");
if (!panelsPath) throw new Error("--panels <file> is required");
const iterations = Number(option("--iterations") ?? 25);
const outDir = resolve(option("--out") ?? "spike-bench");
const inputs = reviveRasterInputs(await Bun.file(panelsPath).text());
const result = await runRasterBench(inputs, { iterations, runtime: `bun ${Bun.version} ${process.platform}-${process.arch}` });
const kernel = { bytes: RASTER_KERNEL_BYTES, sha256: RASTER_KERNEL_SHA256, simd: RASTER_KERNEL_SIMD };
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "bench-bun.json"), JSON.stringify({ kernel, ...result }, null, 2));
console.log(JSON.stringify({ kernel, ...result, tsSamples: undefined, wasmSamples: undefined }, null, 2));
