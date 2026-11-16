import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findChromeExecutable } from "../src/cli/desktop-pane-shot-browser";

// Temporary probe: what still holds a capture's folders after the browser is stopped.
const ARGS = [
  "--headless=new", "--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage",
  "--disable-background-networking", "--disable-default-apps", "--disable-extensions", "--disable-popup-blocking",
  "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
];
const chrome = await findChromeExecutable();
const cache = join(homedir(), ".cache/gloom-smoke/probe");
await mkdir(cache, { recursive: true });

async function sh(cmd: string[]): Promise<string> {
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return out;
}

const snapshotScript = join(cache, "snapshot.ps1");
await Bun.write(snapshotScript, `
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|crashpad' } | ForEach-Object {
  $line = ($_.CommandLine -replace '\\s+', ' ')
  if ($line.Length -gt 300) { $line = $line.Substring(0, 300) }
  "$($_.ProcessId)<-$($_.ParentProcessId) $($_.Name) $line"
}
`);

async function alive(): Promise<string[]> {
  const out = await sh(["tasklist", "/NH", "/FO", "CSV"]);
  return out.split("\n").map((line) => line.split('","')[0]?.replace(/^"/, "") + ":" + line.split('","')[1])
    .filter((entry) => /chrome|crashpad/i.test(entry));
}

async function removeCode(path: string): Promise<string> {
  try {
    await rm(path, { recursive: true, force: true });
    return "ok";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? String(error);
  }
}

async function endpoint(profile: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    try {
      const [port, path] = (await Bun.file(join(profile, "DevToolsActivePort")).text()).split("\n");
      if (port && path?.startsWith("/devtools/browser/")) return `ws://127.0.0.1:${Number(port)}${path.trim()}`;
    } catch { /* not written yet */ }
    await Bun.sleep(50);
  }
  throw new Error("no DevToolsActivePort");
}

type Variant = "kill-cwd-inside" | "kill-cwd-outside" | "tree-kill" | "cdp-close";

async function iteration(variant: Variant, index: number): Promise<void> {
  const work = join(cache, `${variant}-${index}-${Date.now()}`);
  const caller = join(work, "caller with spaces");
  const profile = join(work, "t", "gloom-pane-shot-probe", "chrome-profile");
  await mkdir(caller, { recursive: true });
  await mkdir(profile, { recursive: true });
  const cwd = variant === "kill-cwd-outside" ? (process.env.RUNNER_TEMP ?? "C:\\") : caller;
  const proc = Bun.spawn([chrome, ...ARGS, `--user-data-dir=${profile}`, "--window-size=800,600", "--remote-debugging-port=0", "about:blank"], {
    cwd, stdout: "ignore", stderr: "ignore",
  });
  const socket = new WebSocket(await endpoint(profile));
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
  socket.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "data:text/html,<h1>probe</h1><canvas id=c></canvas>" } }));
  await Bun.sleep(1500);
  if (index === 0) console.log(`[${variant}] process tree before stop:\n${(await sh(["powershell.exe", "-NoProfile", "-File", snapshotScript])).trim()}`);

  if (variant === "tree-kill") {
    await sh(["taskkill", "/PID", String(proc.pid), "/T", "/F"]);
  } else if (variant === "cdp-close") {
    socket.send(JSON.stringify({ id: 2, method: "Browser.close" }));
    const timer = setTimeout(() => proc.kill(), 10_000);
    await proc.exited;
    clearTimeout(timer);
  } else {
    proc.kill();
  }
  await proc.exited;
  const stoppedAt = performance.now();
  socket.close();

  const targets: Array<[string, string]> = [["profile", join(work, "t", "gloom-pane-shot-probe")], ["caller", caller], ["work", work]];
  const firstTry: Record<string, string> = {};
  const removedAfter: Record<string, number> = {};
  const aliveAt: string[] = [];
  let lastAliveSample = -1000;
  while (Object.keys(removedAfter).length < targets.length && performance.now() - stoppedAt < 15_000) {
    const elapsed = Math.round(performance.now() - stoppedAt);
    for (const [label, path] of targets) {
      if (label in removedAfter) continue;
      const code = await removeCode(path);
      firstTry[label] ??= code;
      if (code === "ok") removedAfter[label] = elapsed;
    }
    if (elapsed - lastAliveSample >= 150 && Object.keys(removedAfter).length < targets.length) {
      lastAliveSample = elapsed;
      aliveAt.push(`+${elapsed}ms ${(await alive()).join(" ") || "none"}`);
    }
    await Bun.sleep(20);
  }
  console.log(`[${variant} #${index}] first rm: ${JSON.stringify(firstTry)} removable after (ms): ${JSON.stringify(removedAfter)}`);
  for (const line of aliveAt.slice(0, 4)) console.log(`    alive ${line}`);
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

for (const variant of ["kill-cwd-inside", "kill-cwd-outside", "tree-kill", "cdp-close"] as const) {
  for (let index = 0; index < 4; index++) await iteration(variant, index);
}
