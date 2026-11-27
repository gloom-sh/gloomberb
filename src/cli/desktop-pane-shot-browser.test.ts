import { expect, test } from "bun:test";
import { existsSync } from "fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { chromeSandboxRefused, findChromeExecutable, launchShotBrowser, launchShotBrowserProcess, startsWithoutSandbox } from "./desktop-pane-shot-browser";
import { readRenderedPaneState } from "./desktop-pane-shot";
import { buildDomPaneReportFromRender } from "./pane-functions/dom";
import type { ResolvedPaneFunction } from "./pane-functions/resolver";
import type { PaneScreenshotResult } from "./pane-functions/screenshot-types";

const chrome = await findChromeExecutable().catch(() => null);

async function startPipeCaptureBrowser(chrome: string, folder: string, launch = launchShotBrowserProcess) {
  const start = async (attempt: string) => {
    const userDataDir = join(folder, attempt);
    const emptyHome = join(userDataDir, "empty-home");
    try {
      await mkdir(emptyHome, { recursive: true });
      const browser = await launch(chrome, { widthPx: 400, heightPx: 300, userDataDir, env: { ...process.env, HOME: emptyHome } });
      return { browser, userDataDir };
    } catch (error) {
      await rm(userDataDir, { recursive: true, force: true });
      throw error;
    }
  };

  try {
    return await start("first");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Timed out waiting for Chrome DevTools method Browser.getVersion.") throw error;
    return start("retry");
  }
}

// No other CI step starts the browser a capture draws in. Over the pipe, the browser opens no DevTools port another
// program on the machine could use, and the page's address, which carries the capture server's secret, is not on its
// command line.
test.skipIf(chrome === null || process.platform === "win32")("the capture browser is driven over a pipe and opens the page it is told", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => new URL(request.url).pathname === "/folder/"
      ? new Response("<title>capture</title><script>window.drawn = 42</script>", { headers: { "Content-Type": "text/html" } })
      : new Response("Not found", { status: 404 }),
  });
  let folder: string | undefined;
  try {
    folder = await mkdtemp(join(tmpdir(), "gloom-shot-browser-"));
    const { browser, userDataDir } = await startPipeCaptureBrowser(chrome!, folder);
    try {
      const capture = await browser.newPage();
      await capture.open(`http://127.0.0.1:${server.port}/folder/`);
      const { result } = await capture.page.send("Runtime.evaluate", {
        expression: "`${document.title}:${window.drawn}`",
        returnByValue: true,
      }) as { result: { value: string } };
      expect(result.value).toBe("capture:42");
      expect(existsSync(join(userDataDir, "DevToolsActivePort"))).toBe(false);
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}, 120_000);

const versionTimeout = () => new Error("Timed out waiting for Chrome DevTools method Browser.getVersion.");
test.each([
  ["recovers from the first handshake timeout", [versionTimeout()], true],
  ["fails after a second handshake timeout", [versionTimeout(), versionTimeout()], false],
  ["does not retry other startup errors", [new Error("Chrome DevTools connection closed.")], false],
] as const)("pipe capture %s", async (_scenario, errors, recovers) => {
  const folder = await mkdtemp(join(tmpdir(), "gloom-shot-startup-"));
  const profiles: string[] = [];
  const browser = {
    newPage: async () => { throw new Error("Page creation is outside startup recovery."); },
    close: async () => {},
  };
  try {
    const started = startPipeCaptureBrowser("fake-chrome", folder, async (_chrome, { userDataDir }) => {
      for (const profile of profiles) expect(existsSync(profile)).toBe(false);
      expect(profiles).not.toContain(userDataDir);
      profiles.push(userDataDir);
      const failure = errors[profiles.length - 1];
      if (failure) throw failure;
      return browser;
    });
    if (recovers) {
      expect(await started).toEqual({ browser, userDataDir: profiles[1] });
    } else {
      await expect(started).rejects.toBe(errors.at(-1));
      for (const profile of profiles) expect(existsSync(profile)).toBe(false);
    }
    expect(profiles).toHaveLength(errors.length + Number(recovers));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test.skipIf(chrome === null)("rendered reports omit decorative figures from rows and prose without changing the preview", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gloom-shot-preview-"));
  const decorative = '<span data-gloom-report-ignore="true" style="filter: blur(5px)"><span>Sample only</span></span>';
  const cell = (text: string) => `<span data-gloom-role="data-table-cell">${text}</span>`;
  const row = (text: string) => `<div data-gloom-role="data-table-row">${text}</div>`;
  const html = `<div id="root"><div>Read this ${decorative}</div><div data-gloom-role="data-table">
    <span data-gloom-role="data-table-header-cell">Revenue</span>
    ${row(cell(`12.3B ${decorative}`))}${row(cell(decorative))}
    </div><div data-gloom-ui="key-value-row"><span>Latest ${decorative}</span><span> 12.3B ${decorative}</span></div>
    <div data-gloom-ui="pro-lock">Upgrade to see every product</div></div>`;
  const browser = await launchShotBrowser(chrome!, { widthPx: 400, heightPx: 300, userDataDir: folder });
  try {
    await browser.open(`data:text/html,${encodeURIComponent(html)}`);
    const render = await readRenderedPaneState(browser.page);
    const resolved = { token: "DES", label: "Revenue", capability: { id: "ticker-research" }, options: {}, pane: {}, instance: {} } as ResolvedPaneFunction;
    const report = await buildDomPaneReportFromRender(resolved, { render, symbols: ["EXAMPLE"] } as PaneScreenshotResult);
    expect(report.text).toContain("12.3B");
    expect(report.text).not.toContain("Sample only");
    expect(report.data).toMatchObject({ rowCount: 1, rows: [{ cells: [{ text: "12.3B" }] }] });
    expect(JSON.stringify(report.data)).not.toContain("Sample only");
    expect(render.visibleText).toContain("Read this");
    expect(render.visibleKeyValues).toEqual([{ label: "Latest", text: "Latest 12.3B" }]);
    expect(render.accessGate).toBe("pro");
    const { result } = await browser.page.send("Runtime.evaluate", {
      expression: "document.body.innerText.includes('Sample only')", returnByValue: true,
    }) as { result: { value: boolean } };
    expect(result.value).toBe(true);
  } finally {
    await browser.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);

test("Chrome keeps its sandbox unless it says it cannot have one", () => {
  expect(startsWithoutSandbox("linux", 0)).toBe(true);
  expect(startsWithoutSandbox("linux", 1000)).toBe(false);
  expect(startsWithoutSandbox("darwin", 0)).toBe(false);
  expect(startsWithoutSandbox("win32", undefined)).toBe(false);
  expect(chromeSandboxRefused("[1:1:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+")).toBe(true);
  expect(chromeSandboxRefused("[1:1:ERROR:zygote_host_impl_linux.cc(100)] Running as root without --no-sandbox is not supported.")).toBe(true);
  expect(chromeSandboxRefused("[1:1:ERROR:gpu_init.cc] Passthrough is not supported")).toBe(false);
});

// A stand-in browser: without --no-sandbox it fails as Chrome does with no kernel support for its sandbox; with it, it
// answers the three DevTools calls a start makes. A start without --use-mock-keychain is logged as one that reaches
// the real keychain, which on a Mac with none to hold Chrome's key opens a dialog nobody is there to close.
async function writeFakeChrome(folder: string, starts: string): Promise<string> {
  const fakeChrome = join(folder, "chrome");
  await writeFile(fakeChrome, `#!/usr/bin/env bun
import { appendFileSync, createReadStream, createWriteStream } from "fs";
const sandboxed = !process.argv.includes("--no-sandbox");
const keychain = process.argv.includes("--use-mock-keychain") ? "" : " with the real keychain";
appendFileSync(${JSON.stringify(starts)}, (sandboxed ? "sandboxed" : "unsandboxed") + keychain + "\\n");
if (sandboxed) {
  process.stderr.write("[1:1:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!\\n", () => process.exit(1));
} else {
  const out = createWriteStream("", { fd: 4 });
  let buffered = "";
  createReadStream("", { fd: 3, encoding: "utf8" }).on("data", (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\\0"); end >= 0; end = buffered.indexOf("\\0")) {
      const { id, method, params } = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      const result = method === "Target.createBrowserContext" ? { browserContextId: "private1" }
        : method === "Target.createTarget" ? { targetId: "t1" } : method === "Target.attachToTarget" ? { sessionId: "s1" } : {};
      const error = method === "Target.createTarget" && params.browserContextId !== "private1"
        ? { message: "Capture used the default browser context." } : undefined;
      out.write(JSON.stringify({ id, result, error }) + "\\0");
    }
  });
}
`);
  await chmod(fakeChrome, 0o755);
  return fakeChrome;
}

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a browser that cannot have its sandbox is started again without it, and only then", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gloom-shot-sandbox-"));
  const starts = join(folder, "starts.log");
  const fakeChrome = await writeFakeChrome(folder, starts);
  try {
    const browser = await launchShotBrowser(fakeChrome, { widthPx: 400, heightPx: 300, userDataDir: join(folder, "profile") });
    await browser.close();
    expect((await readFile(starts, "utf8")).trim().split("\n")).toEqual(["sandboxed", "unsandboxed"]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}, 30_000);

// Handed to a browser through node:child_process, the pipes of the DevTools protocol were closed by Bun more than once
// as it exited, and used after. The next child could hold those descriptor numbers by then: its stdout failed to
// register (EBADF), its read never ended, or the next browser start found its connection closed. Once the same
// process's next test, which spawns a child and reads its output, failed that way.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a browser that has exited leaves the pipes of the children started after it alone", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gloom-shot-fds-"));
  const fakeChrome = await writeFakeChrome(folder, join(folder, "starts.log"));
  const problems: string[] = [];
  const printsALot = async () => {
    const child = Bun.spawn([process.execPath, "-e", 'process.stdout.write("x".repeat(400_000))'], { stdout: "pipe", stderr: "pipe" });
    let hung: ReturnType<typeof setTimeout> | undefined;
    try {
      const [stdout, stderr, status] = await Promise.race([
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
        new Promise<never>((_, reject) => { hung = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("its output never ended")); }, 8_000); }),
      ]);
      if (status !== 0 || stderr !== "" || stdout.length !== 400_000) problems.push(`status ${status}, ${stdout.length} bytes, stderr ${JSON.stringify(stderr)}`);
    } finally {
      clearTimeout(hung);
    }
  };
  try {
    for (let round = 0; round < 20; round++) {
      try {
        const browser = await launchShotBrowser(fakeChrome, { widthPx: 400, heightPx: 300, userDataDir: join(folder, `profile${round}`) });
        await browser.close();
        for (let child = 0; child < 3; child++) await printsALot();
      } catch (error) {
        problems.push(`round ${round}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(problems).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);
