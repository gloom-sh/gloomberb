import { chmod, copyFile, mkdir, rm } from "fs/promises";
import { join, resolve } from "path";

/**
 * Prototype build for the Tauri shell (desktop-tauri/):
 *
 * 1. the desktop view, with `electrobun/view` swapped for the Tauri
 *    stand-in (src/renderers/tauri/electroview.ts), into dist/electrobun-view;
 * 2. the desktop backend, with `electrobun/bun` swapped for the Tauri
 *    stand-in and Electrobun's native window workarounds stubbed out, into
 *    desktop-tauri/backend/index.js;
 * 3. this Bun as the sidecar binary Tauri bundles next to the app.
 *
 * Then `bunx @tauri-apps/cli build` in desktop-tauri/src-tauri makes the bundles.
 */

const root = resolve(join(import.meta.dir, "..", ".."));
const tauriDir = join(root, "desktop-tauri");

const view = Bun.spawn(["bun", "run", "scripts/build-electrobun-view.ts"], {
  cwd: root,
  env: { ...process.env, GLOOM_DESKTOP_SHELL: "tauri" },
  stdout: "inherit",
  stderr: "inherit",
});
if (await view.exited !== 0) throw new Error("The view build failed");

const STUBS = ["macos-objc", "windows-native", "windows-quit", "windows-icons", "windows-custom-chrome"];
const backendDir = join(tauriDir, "backend");
await rm(backendDir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(root, "src/renderers/electrobun/bun/index.ts")],
  outdir: backendDir,
  target: "bun",
  format: "esm",
  sourcemap: "external",
  plugins: [{
    name: "tauri-shell",
    setup(build) {
      build.onResolve({ filter: /^electrobun\/bun$/ }, () => ({ path: join(root, "src/renderers/tauri/electrobun-bun.ts") }));
      build.onResolve({ filter: new RegExp(`(^|/)(${STUBS.join("|")})$`) }, (args) => {
        const name = args.path.split("/").pop()!;
        return { path: join(root, "src/renderers/tauri/stubs", `${name}.ts`) };
      });
    },
  }],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("The backend build failed");
}
console.log(`backend: ${result.outputs.map((output) => output.path).join(", ")}`);

const hostLine = Bun.spawnSync(["rustc", "-vV"]).stdout.toString().split("\n").find((line) => line.startsWith("host:"));
const triple = hostLine?.split(":")[1]?.trim();
if (!triple) throw new Error("rustc -vV did not name the host triple");
const binaries = join(tauriDir, "src-tauri", "binaries");
await mkdir(binaries, { recursive: true });
const sidecar = join(binaries, `bun-${triple}${process.platform === "win32" ? ".exe" : ""}`);
await copyFile(process.execPath, sidecar);
await chmod(sidecar, 0o755);
console.log(`sidecar: ${sidecar} (Bun ${Bun.version})`);
