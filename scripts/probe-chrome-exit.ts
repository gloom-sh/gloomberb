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
  $type = if ($line -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }
  $sub = if ($line -match '--utility-sub-type=([A-Za-z.]+)') { '/' + $Matches[1] } else { '' }
  "$($_.ProcessId) $type$sub"
}
`);

async function roles(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const line of (await sh(["powershell.exe", "-NoProfile", "-File", snapshotScript])).split("\n")) {
    const [pid, role] = line.trim().split(" ");
    if (pid && role) map.set(pid, role);
  }
  return map;
}

async function alive(): Promise<string[]> {
  const out = await sh(["tasklist", "/NH", "/FO", "CSV"]);
  return out.split("\n").map((line) => line.split('","')).filter((cols) => /chrome|crashpad/i.test(cols[0] ?? "")).map((cols) => cols[1] ?? "?");
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

const bigScript = Array.from({ length: 40_000 }, (_, i) => `function f${i}(a,b){var c=a+${i};for(var d=0;d<b;d++){c+=d*${i}}return c}`).join("\n") + "\nwindow.__big=true;";
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/big.js") return new Response(bigScript, { headers: { "content-type": "text/javascript", "cache-control": "max-age=3600" } });
    return new Response(`<!doctype html><body style="margin:0"><canvas id=c width=600 height=400></canvas>
<script src="/big.js"></script>
<script>
const gl = document.getElementById("c").getContext("webgl");
if (gl) { gl.clearColor(0.1, 0.4, 0.8, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
localStorage.setItem("probe", "x".repeat(10000));
document.body.append(document.createTextNode("ready " + !!window.__big));
</script></body>`, { headers: { "content-type": "text/html" } });
  },
});

type Variant = "kill" | "tree-kill" | "cdp-close";

async function iteration(variant: Variant, index: number): Promise<void> {
  const work = join(cache, `${variant}-${index}-${Date.now()}`);
  const caller = join(work, "caller with spaces");
  const profile = join(work, "t", "gloom-pane-shot-probe", "chrome-profile");
  await mkdir(caller, { recursive: true });
  await mkdir(profile, { recursive: true });
  const proc = Bun.spawn([chrome, ...ARGS, `--user-data-dir=${profile}`, "--window-size=800,600", "--remote-debugging-port=0", "about:blank"], {
    cwd: caller, stdout: "ignore", stderr: "ignore",
  });
  const socket = new WebSocket(await endpoint(profile));
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
  const pending = new Map<number, (value: any) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) pending.get(message.id)?.(message.result);
  });
  let nextId = 1;
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send("Target.createTarget", { url: `http://127.0.0.1:${server.port}/` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await Bun.sleep(2500);
  await send("Page.captureScreenshot", { format: "png" }, sessionId);
  const before = await roles();

  if (variant === "tree-kill") {
    await sh(["taskkill", "/PID", String(proc.pid), "/T", "/F"]);
  } else if (variant === "cdp-close") {
    socket.send(JSON.stringify({ id: nextId++, method: "Browser.close" }));
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
    if (elapsed - lastAliveSample >= 100 && Object.keys(removedAfter).length < targets.length) {
      lastAliveSample = elapsed;
      aliveAt.push(`+${elapsed}ms ${(await alive()).join(" ") || "none"}`);
    }
    await Bun.sleep(10);
  }
  const survivors = [...before].filter(([pid]) => aliveAt[0]?.includes(pid)).map(([pid, role]) => `${pid}=${role}`);
  const flag = Object.values(firstTry).some((code) => code !== "ok") ? "  <-- LOCKED" : "";
  console.log(`[${variant} #${index}] first rm: ${JSON.stringify(firstTry)} removable after (ms): ${JSON.stringify(removedAfter)}${flag}`);
  if (flag) {
    for (const line of aliveAt.slice(0, 4)) console.log(`    alive ${line}`);
    console.log(`    roles of survivors at first sample: ${survivors.join(" ") || "(none of the browser's own processes)"}`);
  }
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

for (const variant of ["kill", "tree-kill", "cdp-close"] as const) {
  for (let index = 0; index < 12; index++) await iteration(variant, index);
}
server.stop(true);
