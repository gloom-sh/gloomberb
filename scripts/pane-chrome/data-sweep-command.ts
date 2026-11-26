import { spawn, type ChildProcess } from "node:child_process";

export interface CommandResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }

export async function runCommand(
  argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number,
  options: { signal?: AbortSignal; request?: (request: unknown) => Promise<unknown> } = {},
): Promise<CommandResult> {
  const { signal, request } = options;
  if (signal?.aborted) return { stdout: "", stderr: "", exitCode: -1, timedOut: true };
  return new Promise((resolveResult, reject) => {
    const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
      env, detached: process.platform !== "win32", stdio: request ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (name: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error); }
    };
    const stop = () => {
      timedOut = true;
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 2_000);
    };
    const timer = setTimeout(stop, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, 16_000_001); if (stdout.length > 16_000_000) stop(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64_000); });
    if (request) {
      child.on("message", (payload: unknown) => {
        if (timedOut || !child.connected || !payload || typeof payload !== "object" || !("id" in payload) || typeof payload.id !== "number") return;
        const reply = (body: object) => {
          if (!timedOut && child.connected) child.send({ id: payload.id, ...body }, () => {});
        };
        request(payload).then((value) => reply({ value }), (error) => reply({ error: error instanceof Error ? error.message : String(error) }));
      });
    }
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => {
      cleanup();
      kill("SIGKILL");
      resolveResult({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
  });
}
