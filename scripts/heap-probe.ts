import { appendFileSync } from "fs";

// Preloaded into the app by benchmark-tui-memory.ts. On SIGUSR2 it collects
// garbage and appends the live heap, so the benchmark reads what is retained
// rather than RSS, which rises and falls with the collector's timing.
const output = process.env.GLOOMBERB_HEAP_PROBE;
if (output) {
  process.on("SIGUSR2", () => {
    Bun.gc(true);
    appendFileSync(output, `${process.memoryUsage().heapUsed}\n`);
  });
}
