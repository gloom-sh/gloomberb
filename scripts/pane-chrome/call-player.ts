import { mkdir, rm } from "fs/promises";
import { join, resolve } from "path";
import type { BrowserContext, Page } from "playwright-core";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir } from "./browser";
import { serveFixturePage } from "./page";

/**
 * The Calls pane's player in Chromium and WebKit (GLO-922): the layout
 * fixture's invented call (`scenario=layout&pane=calls`) plays a recording
 * made here with ffmpeg, served from its own origin with byte ranges as the
 * signed storage address is. In each browser it clicks a paragraph and checks
 * that playback starts there and the paragraph is marked, that the arrows
 * seek ten seconds and the mark follows, that Space pauses, that the speed
 * and the track work, that Cmd/Ctrl+F reaches the find and Enter steps its
 * matches, that the audio was read in ranges, and that a call without a
 * recording draws no player. It pictures the pane in a dark and a light
 * theme at two widths.
 *
 *   bun run check:call-player [--out <dir>] [--root <checkout>]
 *       [--browsers chromium,webkit] [--themes white,paper] [--widths 640,1280]
 *
 * Needs ffmpeg on the PATH and playwright-core's Chromium and WebKit
 * (`bunx playwright-core install chromium webkit`). Pictures and
 * `report.json` land in `--out` (default under the pane chrome cache).
 */

const args = process.argv.slice(2);
const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
const out = resolve(takeOption(args, "--out") ?? cacheDir("call-player"));
const browsers = (takeOption(args, "--browsers") ?? "chromium,webkit").split(",") as Array<"chromium" | "webkit">;
const themes = (takeOption(args, "--themes") ?? "white,paper").split(",");
const widths = (takeOption(args, "--widths") ?? "640,1280").split(",").map(Number);
const HEIGHT = 800;
const RECORDING_SECONDS = 240;

interface Check { browser: string; name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const ranges: Array<{ range: string | null; status: number }> = [];

async function recording(file: string): Promise<void> {
  // A tone that steps every few seconds, so a seek is audible to anyone listening.
  const run = Bun.spawn([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=22050:duration=${RECORDING_SECONDS}`,
    "-af", "volume=0.15,vibrato=f=0.25:d=0.5", "-ac", "1", "-b:a", "48k", file,
  ], { stdout: "ignore", stderr: "pipe" });
  if (await run.exited !== 0) throw new Error(`ffmpeg could not make the recording: ${await new Response(run.stderr).text()}`);
}

function serveRecording(file: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      // Bun answers a byte range of a file with 206 itself, as storage does.
      const response = new Response(Bun.file(file), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
      queueMicrotask(() => ranges.push({ range: request.headers.get("range"), status: request.headers.get("range") ? 206 : 200 }));
      return response;
    },
  });
}

async function launch(name: "chromium" | "webkit", width: number): Promise<BrowserContext> {
  const engines = await import("playwright-core");
  const profile = join(out, "profiles", name);
  await rm(profile, { recursive: true, force: true });
  return engines[name].launchPersistentContext(profile, { headless: true, viewport: { width, height: HEIGHT }, deviceScaleFactor: 1 });
}

const audioState = (page: Page) => page.evaluate(() => {
  const audio = document.querySelector<HTMLAudioElement>("[data-gloom-role='audio-player'] audio");
  return audio ? { time: audio.currentTime, paused: audio.paused, rate: audio.playbackRate, duration: audio.duration, error: audio.error?.code ?? null } : null;
});
const currentLine = (page: Page) => page.evaluate(() => document.querySelector("[data-gloom-role='playback-line'][data-current='true']")?.textContent ?? null);
const footerText = (page: Page) => page.evaluate(() => document.body.textContent ?? "");

function check(browser: string, name: string, ok: boolean, detail: unknown) {
  checks.push({ browser, name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  console.log(`${ok ? "ok  " : "FAIL"} ${browser.padEnd(8)} ${name}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

async function open(page: Page, url: URL, theme: string, audio: string) {
  const target = new URL(url);
  target.search = new URLSearchParams({ scenario: "layout", pane: "calls", theme, audio }).toString();
  await page.goto(target.href, { waitUntil: "load" });
  await page.waitForFunction(() => document.body.textContent?.includes("The new lens line"), undefined, { timeout: 20_000 });
}

async function lineBox(page: Page, text: string) {
  const line = page.locator("[data-gloom-role='playback-line']", { hasText: text }).first();
  await line.scrollIntoViewIfNeeded();
  return line;
}

async function exercise(browser: "chromium" | "webkit", page: Page, url: URL, recordingUrl: string) {
  await open(page, url, themes[0]!, recordingUrl);
  await page.waitForSelector("[data-gloom-role='audio-player']");
  await page.waitForFunction(() => Number.isFinite(document.querySelector<HTMLAudioElement>("[data-gloom-role='audio-player'] audio")?.duration), undefined, { timeout: 20_000 })
    .catch(() => {});
  const loaded = await audioState(page);
  check(browser, "recording loads", !!loaded && Math.abs((loaded.duration ?? 0) - RECORDING_SECONDS) < 2, loaded);

  await (await lineBox(page, "The new lens line")).click();
  await page.waitForTimeout(1500);
  const playing = await audioState(page);
  check(browser, "a clicked paragraph plays from its start", !!playing && !playing.paused && playing.time >= 52 && playing.time < 56, playing);
  check(browser, "the paragraph heard is marked", (await currentLine(page))?.includes("The new lens line") === true, await currentLine(page));

  await page.mouse.move(2, 2);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  const sought = await audioState(page);
  check(browser, "the arrows seek ten seconds each", !!sought && sought.time >= 82 && sought.time < 87, sought);
  check(browser, "the mark follows playback", (await currentLine(page))?.includes("Turning to the classroom kits") === true, await currentLine(page));
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  const back = await audioState(page);
  check(browser, "left seeks back", !!back && back.time >= 72 && back.time < 78, back);

  await page.keyboard.press(" ");
  await page.waitForTimeout(300);
  const paused = await audioState(page);
  check(browser, "Space pauses", paused?.paused === true, paused);
  const pausedAt = paused?.time ?? 0;
  await page.waitForTimeout(600);
  check(browser, "a paused recording stays put", Math.abs(((await audioState(page))?.time ?? 0) - pausedAt) < 0.05, await audioState(page));

  await page.getByRole("radio", { name: "1.5\u00d7" }).click();
  check(browser, "the speed applies", (await audioState(page))?.rate === 1.5, await audioState(page));
  await page.getByRole("radio", { name: "1\u00d7" }).click();

  const track = page.locator("[data-gloom-role='audio-player'] [role='slider']");
  const box = await track.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  const middle = await audioState(page);
  check(browser, "the track seeks where it is clicked", !!middle && Math.abs(middle.time - RECORDING_SECONDS / 2) < 6, middle);
  check(browser, "the mark follows a seek on the track", (await currentLine(page))?.includes("Operating expenses rose") === true, await currentLine(page));

  await page.mouse.move(2, 2);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  await page.waitForTimeout(200);
  const focused = await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.placeholder ?? document.activeElement?.tagName ?? null);
  check(browser, "Cmd/Ctrl+F reaches the find", focused === "find in transcript", focused);
  await page.keyboard.type("margin");
  await page.waitForTimeout(400);
  const first = (await footerText(page)).match(/match (\d+) of (\d+)/)?.slice(1).join("/") ?? null;
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const second = (await footerText(page)).match(/match (\d+) of (\d+)/)?.slice(1).join("/") ?? null;
  await page.keyboard.press("Shift+Enter");
  await page.waitForTimeout(200);
  const backAgain = (await footerText(page)).match(/match (\d+) of (\d+)/)?.slice(1).join("/") ?? null;
  check(browser, "Enter and Shift+Enter step the find", first === "1/4" && second === "2/4" && backAgain === "1/4", { first, second, backAgain });
  await page.keyboard.press("Escape");

  await open(page, url, themes[0]!, "none");
  await page.waitForTimeout(800);
  const none = await page.evaluate(() => ({
    player: !!document.querySelector("[data-gloom-role='audio-player']"),
    lines: document.querySelectorAll("[data-gloom-role='playback-line']").length,
  }));
  check(browser, "a call without a recording draws no player", !none.player && none.lines === 0, none);
}

/** The pane with a paragraph playing, paused there so the picture holds, and the pointer on the one after. */
async function picture(page: Page, url: URL, theme: string, recordingUrl: string, file: string) {
  await open(page, url, theme, recordingUrl);
  await page.waitForSelector("[data-gloom-role='audio-player']");
  await page.waitForFunction(() => Number.isFinite(document.querySelector<HTMLAudioElement>("[data-gloom-role='audio-player'] audio")?.duration), undefined, { timeout: 20_000 })
    .catch(() => {});
  await (await lineBox(page, "The new lens line")).click();
  await page.waitForTimeout(1200);
  await page.keyboard.press(" ");
  const next = await lineBox(page, "Turning to the classroom kits");
  const box = await next.boundingBox();
  if (box) await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: file });
}

/** The find on its second match: every match marked, the one it is on set solid. */
async function pictureFind(page: Page, url: URL, theme: string, recordingUrl: string, file: string) {
  await open(page, url, theme, recordingUrl);
  await page.waitForSelector("[data-gloom-role='audio-player']");
  await page.mouse.move(2, 2);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  await page.keyboard.type("margin");
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await page.screenshot({ path: file });
}

await mkdir(out, { recursive: true });
const recordingFile = join(out, "fixture-call.mp3");
await recording(recordingFile);
const audioServer = serveRecording(recordingFile);
const recordingUrl = `http://127.0.0.1:${audioServer.port}/calls/fixture-call.mp3`;
const fixture = await serveFixturePage(root, join(out, "page"));
const shots: string[] = [];
try {
  for (const browser of browsers) {
    const context = await launch(browser, Math.max(...widths));
    try {
      const page = context.pages()[0] ?? await context.newPage();
      page.on("pageerror", (error) => check(browser, "page error", false, error.message));
      await exercise(browser, page, fixture.url, recordingUrl);
      for (const theme of themes) {
        for (const width of widths) {
          await page.setViewportSize({ width, height: HEIGHT });
          const file = join(out, `player-${browser}-${theme}-${width}.png`);
          await picture(page, fixture.url, theme, recordingUrl, file);
          shots.push(file);
        }
        const find = join(out, `find-${browser}-${theme}-${Math.max(...widths)}.png`);
        await page.setViewportSize({ width: Math.max(...widths), height: HEIGHT });
        await pictureFind(page, fixture.url, theme, recordingUrl, find);
        shots.push(find);
      }
    } finally {
      await context.close();
    }
  }
  check("server", "the recording is read in byte ranges", ranges.some((entry) => entry.status === 206), `${ranges.filter((entry) => entry.status === 206).length} of ${ranges.length} requests`);
} finally {
  audioServer.stop(true);
  await fixture.close();
}
await Bun.write(join(out, "report.json"), JSON.stringify({ checks, shots, ranges: ranges.length }, null, 2));
const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed; pictures in ${out}`);
if (failed.length > 0) process.exit(1);
