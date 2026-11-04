import { expect, test } from "bun:test";
import { existsSync } from "fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { chromeSandboxRefused, findChromeExecutable, launchShotBrowser, startsWithoutSandbox } from "./desktop-pane-shot-browser";

const chrome = await findChromeExecutable().catch(() => null);

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
  const userDataDir = await mkdtemp(join(tmpdir(), "gloom-shot-browser-"));
  const browser = await launchShotBrowser(chrome!, { widthPx: 400, heightPx: 300, userDataDir });
  try {
    await browser.open(`http://127.0.0.1:${server.port}/folder/`);
    const { result } = await browser.page.send("Runtime.evaluate", {
      expression: "`${document.title}:${window.drawn}`",
      returnByValue: true,
    }) as { result: { value: string } };
    expect(result.value).toBe("capture:42");
    expect(existsSync(join(userDataDir, "DevToolsActivePort"))).toBe(false);
  } finally {
    await browser.close();
    server.stop(true);
    await rm(userDataDir, { recursive: true, force: true });
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
// answers the three DevTools calls a start makes.
async function writeFakeChrome(folder: string, starts: string): Promise<string> {
  const fakeChrome = join(folder, "chrome");
  await writeFile(fakeChrome, `#!/usr/bin/env bun
import { appendFileSync, createReadStream, createWriteStream } from "fs";
const sandboxed = !process.argv.includes("--no-sandbox");
appendFileSync(${JSON.stringify(starts)}, sandboxed ? "sandboxed\\n" : "unsandboxed\\n");
if (sandboxed) {
  process.stderr.write("[1:1:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!\\n", () => process.exit(1));
} else {
  const out = createWriteStream("", { fd: 4 });
  let buffered = "";
  createReadStream("", { fd: 3, encoding: "utf8" }).on("data", (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\\0"); end >= 0; end = buffered.indexOf("\\0")) {
      const { id, method } = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      const result = method === "Target.createTarget" ? { targetId: "t1" } : method === "Target.attachToTarget" ? { sessionId: "s1" } : {};
      out.write(JSON.stringify({ id, result }) + "\\0");
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
