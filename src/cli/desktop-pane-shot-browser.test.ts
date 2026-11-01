import { expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { findChromeExecutable, launchShotBrowser } from "./desktop-pane-shot-browser";

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
