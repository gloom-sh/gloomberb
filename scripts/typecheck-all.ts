const PROJECTS = [
  { name: "opentui", config: "tsconfig.opentui.json" },
  { name: "dom", config: "tsconfig.dom.json" },
  { name: "cloudflare", config: "tsconfig.cloudflare.json" },
  { name: "scripts", config: "tsconfig.scripts.json" },
  { name: "plugin-tests", config: "tsconfig.plugin-tests.json" },
] as const;

function supportsBunCheck(version = Bun.version): boolean {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 4);
}

const useTsc = process.argv.includes("--tsc") || process.env.TYPECHECK_USE_TSC === "1" || !supportsBunCheck();
const defaultWorkers = useTsc ? 4 : 2;
const rawWorkers = Number.parseInt(process.env.TYPECHECK_CONCURRENCY ?? String(defaultWorkers), 10);
const concurrency = Math.max(1, Math.min(PROJECTS.length, Number.isFinite(rawWorkers) && rawWorkers > 0 ? rawWorkers : defaultWorkers));

type Outcome = { name: string; code: number; output: string; ms: number };
const outcomes = new Array<Outcome>(PROJECTS.length);
let next = 0;

async function runProject(index: number): Promise<void> {
  const project = PROJECTS[index]!;
  const start = performance.now();
  const cmd = useTsc
    ? ["tsc", "--project", project.config]
    : [process.execPath, "check", "--no-pretty", "--all", "--threads=4", "--project", project.config];
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  outcomes[index] = {
    name: project.name,
    code,
    output: `${stdout}${stderr}`,
    ms: Math.round(performance.now() - start),
  };
}

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < PROJECTS.length) {
      const idx = next++;
      await runProject(idx);
    }
  }),
);

const tool = useTsc ? "tsc" : "bun check";
let failed = false;
for (const outcome of outcomes) {
  if (outcome.code !== 0) {
    failed = true;
    console.error(`\n[typecheck:${outcome.name}] (${tool}) failed (exit ${outcome.code}, ${(outcome.ms / 1000).toFixed(2)}s):`);
    if (outcome.output.trim()) console.error(outcome.output.trimEnd());
  } else {
    console.log(`[typecheck:${outcome.name}] (${tool}) ok (${(outcome.ms / 1000).toFixed(2)}s)`);
  }
}

process.exitCode = failed ? 1 : 0;
