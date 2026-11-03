/**
 * Reads the report `plugin doctor --json` prints and decides whose fault a
 * plugin that did not load is, for check-packaged-registry-plugins.ts.
 */

/**
 * The doctor checks that run the plugin in the terminal under test: its
 * entry, the host's runtime links, the import that evaluates it, and the
 * desktop's browser build that the bundler makes of it. The others (the Gloom
 * a plugin declares, removed imports, the id, targets, hosts) read the
 * plugin's files alone and answer the same in any build.
 */
const LOAD_CHECKS: ReadonlySet<string> = new Set(["entry", "host-link", "export", "browser-build"]);

export interface LoadProblem {
  /** The doctor check, or `process` when no report came back. */
  check: string;
  message: string;
}

export interface DoctorRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

interface DoctorReport {
  checks?: Array<{ id?: unknown; status?: unknown; message?: unknown }>;
}

function firstLines(text: string, count = 3): string {
  return text.trim().split("\n").slice(0, count).map((line) => line.trim()).filter(Boolean).join(" ");
}

/** The JSON a command printed, found even when a log line came before it. */
function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/^\{/m);
    if (start < 0) return null;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return null;
    }
  }
}

/**
 * What kept the plugin from loading, from one run of `plugin doctor --json`
 * on it: its failed load checks, or a `process` problem when the command
 * printed no report (it crashed, hung or could not start).
 */
export function loadProblems(run: DoctorRun): LoadProblem[] {
  if (run.timedOut) return [{ check: "process", message: "plugin doctor did not finish in time" }];
  const body = parseJson(run.stdout) as { ok?: unknown; data?: unknown; error?: unknown } | null;
  if (!body || body.ok !== true || !Array.isArray(body.data)) {
    const reason = typeof body?.error === "string" ? body.error : firstLines(run.stderr) || firstLines(run.stdout);
    return [{ check: "process", message: `plugin doctor printed no report (exit ${run.exitCode}): ${reason || "no output"}` }];
  }
  const problems: LoadProblem[] = [];
  for (const report of body.data as DoctorReport[]) {
    for (const check of report.checks ?? []) {
      if (check.status !== "fail" || typeof check.id !== "string" || !LOAD_CHECKS.has(check.id)) continue;
      problems.push({ check: check.id, message: typeof check.message === "string" ? check.message : "" });
    }
  }
  return problems;
}

const HOST_MODULE = /^(?:react(?:\/[^']*)?|gloomberb(?:\/[^']*)?|gloom-host:.*)$/;

/**
 * True when the problem is the host not serving what every plugin may import:
 * a named export missing from React or a `gloomberb/*` module, or one of
 * those modules not resolving. No plugin causes that, so it needs no second
 * opinion.
 *
 * This is the failure of v0.19.3 to v0.19.5: the binary served React with a
 * default export and nothing else, and `import { useCallback } from "react"`
 * failed in every plugin.
 */
export function isHostLinkError(message: string): boolean {
  const missingExport = /Export named '[^']+' not found in module '([^']+)'/.exec(message);
  if (missingExport) return HOST_MODULE.test(missingExport[1]!);
  // The loader's own wording once it has recognised the module as the host's
  // (a removed export reads "removed in Gloom", and is a plugin to update).
  if (/\bUses \S+ from gloomberb\S*, which Gloom \S+ does not have\b/.test(message)) return true;
  const unresolved = /Cannot find (?:package|module) '([^']+)'/.exec(message);
  return unresolved ? HOST_MODULE.test(unresolved[1]!) : false;
}
