import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PANE_SWEEP_EVIDENCE_PATH } from "../../src/cli/pane-functions/screenshot-types";
import { captureEvidence } from "./data-sweep";
import { runCommand } from "./data-sweep-command";
import { pluginLaneEnv } from "./data-sweep-plugins";
import { createSweepShot } from "./data-sweep-shot";

async function withFakeChrome(run: (fixture: { folder: string; env: Record<string, string>; log(): Promise<string[]> }) => Promise<void>) {
  const root = join(homedir(), ".cache", "gloom-smoke");
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(join(root, "test-sweep-shot-"));
  const chrome = join(folder, "chrome");
  const logPath = join(folder, "events");
  const env = pluginLaneEnv({ ...process.env, CHROME_PATH: chrome }, folder);
  try {
    await mkdir(env.HOME!, { recursive: true });
    await mkdir(env.TMPDIR!, { recursive: true });
    await writeFile(join(folder, "config.json"), JSON.stringify({ dataDir: folder, onboardingComplete: true }));
    await writeFile(chrome, `#!${process.execPath}\nconst logPath = ${JSON.stringify(logPath)};\n` + String.raw`
import { appendFileSync, createReadStream, writeSync } from "node:fs";
const log = (text) => appendFileSync(logPath, text + "\n");
if (!process.argv.includes("--remote-debugging-pipe") || process.argv.some((arg) => arg.startsWith("--remote-debugging-port"))) process.exit(2);
log("start");
process.on("SIGTERM", () => { log("exit"); process.exit(0); });
let next = 0;
const contexts = new Map();
const reply = (message) => writeSync(4, JSON.stringify(message) + "\0");
async function dispatch({ id, method, params, sessionId }) {
  const context = contexts.get(sessionId);
  let result = {};
  if (method === "Target.createBrowserContext") {
    const browserContextId = String(++next);
    if (contexts.size) log("context overlap");
    contexts.set(browserContextId, { fixture: "" });
    log("create " + browserContextId);
    result = { browserContextId };
  } else if (method === "Target.createTarget") {
    if (!contexts.has(params.browserContextId)) throw new Error("Missing private context");
    result = { targetId: params.browserContextId };
  } else if (method === "Target.attachToTarget") {
    result = { sessionId: params.targetId };
  } else if (method === "Target.disposeBrowserContext") {
    contexts.delete(params.browserContextId);
    log("dispose " + params.browserContextId);
  } else if (method === "Emulation.setDeviceMetricsOverride") {
    context.fixture = params.width === 1600 ? "Wide fixture" : "Narrow fixture";
  } else if (method === "Page.navigate") {
    const html = await (await fetch(params.url)).text();
    if (!html.includes("__GLOOM_CLI_SHOT_PAYLOAD__")) throw new Error("Not a shot page");
    reply({ method: "Page.loadEventFired", sessionId });
  } else if (method === "Runtime.evaluate") {
    if (params.expression === "hang") { log("hang " + sessionId); return; }
    if (params.expression === "crash") { log("crash"); process.exit(7); }
    const ready = params.expression.includes("__GLOOM_CLI_SHOT_READY__");
    result = { result: { value: ready ? { ready: true } : {
      visibleText: context.fixture, rows: [], contentFigures: 24,
      errorStateDetected: context.fixture === "Narrow fixture", errorStateMarkers: context.fixture === "Narrow fixture" ? ["Fixture failed."] : [],
    } } };
  } else if (method === "Page.captureScreenshot") {
    result = { data: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(context.fixture)]).toString("base64") };
  }
  reply({ id, result });
}
let buffered = "";
createReadStream("", { fd: 3, encoding: "utf8" }).on("data", (chunk) => {
  buffered += chunk;
  for (let end = buffered.indexOf("\0"); end >= 0; end = buffered.indexOf("\0")) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    dispatch(message).catch((error) => reply({ id: message.id, error: { message: error.message } }));
  }
});
`, { mode: 0o700 });
    await run({ folder, env, log: async () => (await readFile(logPath, "utf8")).trim().split("\n") });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const cli = [process.execPath, "--no-env-file", join(import.meta.dir, "../../src/cli/entry.ts")];

test.skipIf(process.platform === "win32")("strict sweep shots lease separate contexts and keep failed evidence; standalone shot owns its browser", async () => {
  await withFakeChrome(async ({ folder, env, log }) => {
    const signal = new AbortController().signal;
    const sweep = createSweepShot(cli, async () => ({ profile: join(folder, "browser"), env }), signal);
    const shot = (width: string, path: string) => ["shot", "DOCS", "--strict", "--json", "--width", width, "--output", path];
    try {
      const first = join(folder, "first.png");
      const firstRaw = await sweep.run(shot("1600", first), { ...env, [PANE_SWEEP_EVIDENCE_PATH]: first }, 20_000);
      const firstAssessment = await captureEvidence(firstRaw, "DOCS", "first.png", Bun.file(first));
      expect(firstAssessment).toMatchObject({ status: "pass", visibleText: "Wide fixture", png: "first.png" });
      expect(await Bun.file(first).slice(8).text()).toBe("Wide fixture");

      const second = join(folder, "second.png");
      const secondRaw = await sweep.run(shot("1400", second), { ...env, [PANE_SWEEP_EVIDENCE_PATH]: second }, 20_000);
      const secondAssessment = await captureEvidence(secondRaw, "DOCS", "second.png", Bun.file(second));
      expect(secondAssessment).toMatchObject({ status: "failure", visibleText: "Narrow fixture", png: "second.png" });
      expect(secondRaw.exitCode).not.toBe(0);
      expect(await Bun.file(second).slice(8).text()).toBe("Narrow fixture");
    } finally {
      await sweep.close();
    }
    expect(await log()).toEqual(["start", "create 1", "dispose 1", "create 2", "dispose 2", "exit"]);

    const output = join(folder, "standalone.png");
    const standalone = await runCommand([...cli, ...shot("1600", output)], env, 20_000);
    expect(standalone.exitCode).toBe(0);
    expect(await Bun.file(output).slice(8).text()).toBe("Wide fixture");
    expect((await log()).slice(6)).toEqual(["start", "create 1", "exit"]);
  });
}, 65_000);

test.skipIf(process.platform === "win32")("a timed-out worker loses its context and a crashed browser is never replaced", async () => {
  await withFakeChrome(async ({ folder, env, log }) => {
    const signal = new AbortController().signal;
    const sweep = createSweepShot([process.execPath], async () => ({ profile: join(folder, "browser"), env }), signal);
    function request(expression: string) {
      return ["-e", `process.send({ id: 1, method: "Runtime.evaluate", params: { expression: ${JSON.stringify(expression)} } });
        process.on("message", () => process.exit(1)); setInterval(() => {}, 1000);`];
    }
    try {
      expect((await sweep.run(request("hang"), env, 1_500)).timedOut).toBe(true);
      expect(await log()).toEqual(["start", "create 1", "hang 1", "dispose 1"]);
      expect((await sweep.run(request("crash"), env, 5_000)).exitCode).toBe(1);
      const unavailable = await sweep.run(request("hang"), env, 5_000);
      expect(unavailable.stderr).toContain("Chrome DevTools connection closed");
    } finally {
      await sweep.close();
    }
    expect(await log()).toEqual(["start", "create 1", "hang 1", "dispose 1", "create 2", "crash"]);
  });
}, 15_000);
