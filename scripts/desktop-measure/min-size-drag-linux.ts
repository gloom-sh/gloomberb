/**
 * The Linux side of min-size-drag.swift, under X11 with openbox: starts the
 * app, reads the minimum size its window gives the window manager
 * (WM_NORMAL_HINTS), then resizes it far past that the way openbox does by
 * hand (Alt and the right button, from the bottom right quarter), reading
 * the window's size after every move while the button is held. The window
 * has to stop at the minimum, never go under it and jump back.
 *
 *   bun scripts/desktop-measure/min-size-drag-linux.ts --launch <app>/bin/launcher --min 640x400 --out result.json [--require]
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

const launchPath = option("--launch");
const minText = option("--min");
const outPath = option("--out");
if (!launchPath || !minText || !outPath) {
  console.error("usage: min-size-drag-linux.ts --launch <launcher> --min <width>x<height> --out <file> [--require]");
  process.exit(2);
}
const required = process.argv.includes("--require");
const [minWidth = 0, minHeight = 0] = minText.split("x").map(Number);

function xdotool(...args: string[]): string {
  const run = Bun.spawnSync(["xdotool", ...args], { stdout: "pipe", stderr: "pipe" });
  return run.stdout.toString().trim();
}

function geometry(window: string): { x: number; y: number; width: number; height: number } | null {
  const values = Object.fromEntries(xdotool("getwindowgeometry", "--shell", window).split("\n").map((line) => line.split("=")));
  const width = Number(values.WIDTH);
  return width > 0 ? { x: Number(values.X), y: Number(values.Y), width, height: Number(values.HEIGHT) } : null;
}

const result: Record<string, unknown> = { minimum: { width: minWidth, height: minHeight } };
const app = Bun.spawn([launchPath], { stdout: "ignore", stderr: "ignore" });

function finish(passed: boolean, detail: string): never {
  Object.assign(result, { passed, detail });
  mkdirSync(dirname(outPath!), { recursive: true });
  writeFileSync(outPath!, JSON.stringify(result, null, 2));
  console.log(`${passed ? "pass" : "fail"}: ${detail}`);
  app.kill();
  Bun.spawnSync(["pkill", "-f", dirname(dirname(launchPath!))]);
  process.exit(required && !passed ? 1 : 0);
}

let window = "";
for (let attempt = 0; attempt < 180 && !window; attempt++) {
  const found = xdotool("search", "--onlyvisible", "--name", "Gloom").split("\n").filter(Boolean);
  // The biggest one: the main window.
  window = found.map((id) => ({ id, size: geometry(id) })).filter((entry) => (entry.size?.width ?? 0) > 200)
    .sort((a, b) => b.size!.width * b.size!.height - a.size!.width * a.size!.height)[0]?.id ?? "";
  if (!window) await Bun.sleep(500);
}
if (!window) finish(false, "no window of the app came within 90 s");
await Bun.sleep(6000);
result.hints = Bun.spawnSync(["xprop", "-id", window, "WM_NORMAL_HINTS"], { stdout: "pipe" }).stdout.toString().trim();
const before = geometry(window);
if (!before) finish(false, "the window went away");
result.before = before;

const grab = { x: Math.round(before.x + before.width * 0.85), y: Math.round(before.y + before.height * 0.85) };
const target = { x: Math.round(before.x + minWidth / 3), y: Math.round(before.y + minHeight / 3) };
const samples: Array<{ width: number; height: number }> = [];
const sample = () => {
  const size = geometry(window);
  if (size) samples.push({ width: size.width, height: size.height });
};
xdotool("windowactivate", "--sync", window);
xdotool("mousemove", String(grab.x), String(grab.y));
await Bun.sleep(300);
xdotool("keydown", "alt");
xdotool("mousedown", "3");
await Bun.sleep(150);
const steps = 30;
for (let step = 1; step <= steps; step++) {
  xdotool("mousemove", String(Math.round(grab.x + ((target.x - grab.x) * step) / steps)), String(Math.round(grab.y + ((target.y - grab.y) * step) / steps)));
  await Bun.sleep(30);
  sample();
}
await Bun.sleep(300);
sample();
xdotool("mouseup", "3");
xdotool("keyup", "alt");
await Bun.sleep(1200);

const after = geometry(window) ?? { x: 0, y: 0, width: 0, height: 0 };
result.after = after;
result.samples = samples;
const smallest = {
  width: Math.min(after.width, ...samples.map((size) => size.width)),
  height: Math.min(after.height, ...samples.map((size) => size.height)),
};
const under = samples.filter((size) => size.width < minWidth - 1 || size.height < minHeight - 1);
const resized = Math.abs(after.width - before.width) > 2 || Math.abs(after.height - before.height) > 2;
const atMinimum = Math.abs(after.width - minWidth) <= 2 && Math.abs(after.height - minHeight) <= 2;
const problems = [
  ...(resized ? [] : ["the drag did not resize the window"]),
  ...(under.length ? [`went under the minimum while held (${under.length} of ${samples.length} readings, down to ${smallest.width}x${smallest.height})`] : []),
  ...(atMinimum ? [] : [`ended at ${after.width}x${after.height}`]),
];
finish(!problems.length, [
  ...problems,
  `minimum ${minWidth}x${minHeight}; ${before.width}x${before.height} -> ${after.width}x${after.height}, smallest while held ${smallest.width}x${smallest.height}`,
].join("; "));
