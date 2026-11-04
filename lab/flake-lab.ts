// Temporary: loops the piped large-report child to measure how often it fails.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const repo = process.cwd();
const script = `
    import { printCliResult } from ${JSON.stringify(repo + "/src/cli/result.ts")};
    import { DEFAULT_CLI_OPTIONS } from ${JSON.stringify(repo + "/src/cli/options.ts")};
    // CLI color/terminal detection initializes the stream before reports print.
    void process.stdout;
    printCliResult({ data: { rows: Array.from({ length: 6000 }, (_, id) => ({ id, name: "東京 — research report" })) } },
      { ...DEFAULT_CLI_OPTIONS, format: "json" });
`;
const [phase = "plain", iterations = "500", parallel = "1"] = process.argv.slice(2);
const strace = phase === "strace";
mkdirSync("/tmp/lab", { recursive: true });

function sys() {
  const read = (p: string) => { try { return readFileSync(p, "utf8").trim().replace(/\n+/g, " | ").slice(0, 300); } catch { return "n/a"; } };
  return {
    loadavg: read("/proc/loadavg"),
    threads: read("/proc/self/status").match(/Threads:\s*\d+/)?.[0],
    pidsCurrent: read("/sys/fs/cgroup/pids.current"), pidsMax: read("/sys/fs/cgroup/pids.max"),
    memCurrent: read("/sys/fs/cgroup/memory.current"), memMax: read("/sys/fs/cgroup/memory.max"),
    memPressure: read("/proc/pressure/memory"),
  };
}

let failures = 0, done = 0, next = 0;
const kinds: Record<string, number> = {};
async function one(index: number) {
  const started = performance.now();
  const trace = `/tmp/lab/trace-${index}.txt`;
  const command = strace ? ["strace", "-f", "-tt", "-s", "64", "-o", trace, process.execPath, "-e", script] : [process.execPath, "-e", script];
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  let problem = "";
  if (status !== 0 || stderr !== "") problem = `status=${status} signal=${child.signalCode} stderr=${JSON.stringify(stderr.slice(0, 200))} stdout=${stdout.length}`;
  else {
    try { if (JSON.parse(stdout).data.rows.length !== 6000) problem = "short rows"; } catch { problem = `bad json stdout=${stdout.length}`; }
  }
  done++;
  if (!problem) return;
  failures++;
  kinds[problem] = (kinds[problem] ?? 0) + 1;
  if (failures <= 3) {
    console.log(`FAIL #${index} after ${(performance.now() - started).toFixed(0)} ms: ${problem}`);
    console.log("  stdout head:", JSON.stringify(stdout.slice(0, 160)), "tail:", JSON.stringify(stdout.slice(-160)));
    console.log("  system:", JSON.stringify(sys()));
    if (strace && existsSync(trace)) {
      const lines = readFileSync(trace, "utf8").split("\n");
      const interesting = lines.filter((line) => /exit_group|exited with|ECONNRESET|EPIPE|SIGPIPE|SIGSEGV|SIGABRT|killed|ENOMEM|EMFILE|EAGAIN\)? *(?!.*futex)/.test(line) && !/futex/.test(line));
      console.log(`  strace: ${lines.length} lines; interesting:\n${interesting.slice(-40).join("\n")}`);
      console.log(`  strace tail:\n${lines.slice(-60).join("\n")}`);
      writeFileSync(`/tmp/lab/failed-${index}.txt`, lines.join("\n"));
    }
  }
}

const total = Number(iterations);
await Promise.all(Array.from({ length: Number(parallel) }, async () => {
  while (next < total) await one(next++);
}));
console.log(`RESULT phase=${phase} parallel=${parallel} ${JSON.stringify({ iterations: done, failures, kinds })}`);
