import { join } from "node:path";
import { findChromeExecutable, launchShotBrowserProcess, type ShotBrowser, type ShotBrowserProcess } from "../../src/cli/desktop-pane-shot-browser";
import { isRecord } from "../../src/utils/guards";
import { runCommand, type CommandResult } from "./data-sweep-command";

const methods = new Set(["Runtime.enable", "Runtime.evaluate", "Emulation.setDeviceMetricsOverride",
  "Emulation.setDefaultBackgroundColorOverride", "Page.captureScreenshot"]);

async function pageRequest(page: ShotBrowser, request: unknown): Promise<unknown> {
  if (isRecord(request)) {
    if (request.method === "open" && typeof request.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\/[\da-f]{64}\/$/.test(request.url)) {
      return page.open(request.url);
    }
    if (typeof request.method === "string" && methods.has(request.method) && (request.params === undefined || isRecord(request.params))) {
      return page.page.send(request.method, request.params);
    }
  }
  throw new Error("Invalid sweep page request.");
}

export function createSweepShot(
  cli: string[], prepareBrowser: () => Promise<{ profile: string; env: NodeJS.ProcessEnv }>, signal: AbortSignal,
) {
  let browser: Promise<ShotBrowserProcess> | undefined;
  const worker = [cli[0]!, "--preload", join(import.meta.dir, "data-sweep-shot-worker.ts"), ...cli.slice(1)];
  return {
    async run(argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CommandResult> {
      const captureSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const errorResult = (error: unknown): CommandResult => ({ stdout: "", exitCode: 1, timedOut: captureSignal.aborted,
        stderr: JSON.stringify({ ok: false, error: { code: "sweep_browser", message: error instanceof Error ? error.message : String(error) } }) });
      if (captureSignal.aborted) return errorResult(captureSignal.reason);
      let page: ShotBrowser;
      try {
        browser ??= (async () => {
          const { profile, env } = await prepareBrowser();
          return launchShotBrowserProcess(await findChromeExecutable(env.CHROME_PATH), {
            widthPx: 1600, heightPx: 900, userDataDir: join(profile, "chrome"), privatePipe: true, env, signal: captureSignal,
          });
        })();
        page = await (await browser).newPage(captureSignal);
      } catch (error) {
        return errorResult(error);
      }
      const result = await runCommand([...worker, ...argv], env, timeoutMs, { signal: captureSignal, request: (request) => pageRequest(page, request) }).catch(errorResult);
      try {
        await page.close();
      } catch (error) {
        if (!result.timedOut && result.exitCode === 0) return errorResult(error);
      }
      return result;
    },
    async close() {
      const owned = await browser?.catch(() => undefined);
      await owned?.close();
    },
  };
}
