/**
 * Applies this app's changes to Electrobun's SDK:
 * `bun scripts/patch-electrobun-devkit.ts`.
 *
 * Electrobun 2 keeps its SDK out of node_modules. Hutch puts the version the
 * `electrobun` dependency names in `.hutch/devkit` (`bunx electrobun sync`),
 * and the app's main process and its page are bundled from there, so a bun
 * patch of the package has nothing to act on. The changes live in
 * `patches/electrobun-devkit@<version>.patch` instead, a diff against that
 * folder, and this applies them. It is the desktop build's first step, and
 * runs again on every build: a hunk already applied is left as it is, one that
 * neither applies nor is applied stops the build.
 *
 * The page's preload ships compiled into a string, so a change to its source
 * compiles it again with the SDK's own build script.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const DEVKIT_DIR = join(ROOT, ".hutch", "devkit");
const PRELOAD_SOURCE = "api/preload/";
const COMPILED_PRELOAD = join(DEVKIT_DIR, "api", "preload", ".generated", "compiled.ts");
/** In the compiled preload once the patched source is in it. */
const COMPILED_PRELOAD_MARKER = "fromBase64";

interface Hunk {
  before: string;
  after: string;
}

interface FilePatch {
  path: string;
  hunks: Hunk[];
}

/** The files and hunks of a `git diff`, each hunk as the text it replaces and the text it puts there. */
function parsePatch(text: string): FilePatch[] {
  const files: FilePatch[] = [];
  let file: FilePatch | null = null;
  let hunk: { before: string[]; after: string[] } | null = null;
  const closeHunk = () => {
    if (file && hunk) file.hunks.push({ before: hunk.before.join("\n"), after: hunk.after.join("\n") });
    hunk = null;
  };
  // A Windows checkout gives the patch CRLF line ends.
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      closeHunk();
      file = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      file = { path, hunks: [] };
      files.push(file);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("index ")) continue;
    if (line.startsWith("@@")) {
      closeHunk();
      hunk = { before: [], after: [] };
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-")) hunk.before.push(line.slice(1));
    else if (line.startsWith("+")) hunk.after.push(line.slice(1));
    else if (line.startsWith(" ")) {
      hunk.before.push(line.slice(1));
      hunk.after.push(line.slice(1));
    }
  }
  closeHunk();
  return files;
}

function occurrences(text: string, part: string): number {
  let count = 0;
  for (let index = text.indexOf(part); index !== -1; index = text.indexOf(part, index + 1)) count += 1;
  return count;
}

/**
 * `content` with `hunks` applied, by the whole lines each replaces rather than
 * by line number. A hunk whose result is already there once, and its original
 * not, is taken as applied. Throws on one that is neither.
 */
function applyHunks(path: string, content: string, hunks: readonly Hunk[]): string {
  // Bounded by newlines, so a hunk only ever matches whole lines.
  let next = `\n${content}\n`;
  for (const [index, hunk] of hunks.entries()) {
    const before = `\n${hunk.before}\n`;
    const after = `\n${hunk.after}\n`;
    const found = occurrences(next, before);
    if (found === 1) {
      next = next.replace(before, () => after);
      continue;
    }
    if (found === 0 && occurrences(next, after) === 1) continue;
    throw new Error(`${path}: hunk ${index + 1} of the Electrobun SDK patch ${found === 0 ? "does not apply" : "applies in more than one place"}`);
  }
  return next.slice(1, -1);
}

/** The Electrobun version Hutch put in `.hutch/devkit`, from the record it keeps there. */
function devkitVersion(): string {
  const projection = join(DEVKIT_DIR, "projection.json");
  if (!existsSync(projection)) {
    throw new Error("The Electrobun SDK is not in .hutch/devkit. Run `bun run desktop:sync` first.");
  }
  return (JSON.parse(readFileSync(projection, "utf8")) as { product?: { version?: string } }).product?.version ?? "";
}

/** Applies the patch for the SDK in `.hutch/devkit`. Resolves to the files it changed. */
export async function patchElectrobunDevkit(): Promise<string[]> {
  const version = devkitVersion();
  const patchPath = join(ROOT, "patches", `electrobun-devkit@${version}.patch`);
  if (!existsSync(patchPath)) {
    throw new Error(`No Electrobun SDK patch for ${version}: patches/electrobun-devkit@${version}.patch is missing.`);
  }
  const changed: string[] = [];
  for (const file of parsePatch(readFileSync(patchPath, "utf8"))) {
    const path = join(DEVKIT_DIR, file.path);
    const content = readFileSync(path, "utf8");
    const crlf = content.includes("\r\n");
    const patched = applyHunks(file.path, crlf ? content.replaceAll("\r\n", "\n") : content, file.hunks);
    const next = crlf ? patched.replaceAll("\n", "\r\n") : patched;
    if (next === content) continue;
    writeFileSync(path, next);
    changed.push(file.path);
  }
  const preloadChanged = changed.some((path) => path.startsWith(PRELOAD_SOURCE));
  if (preloadChanged || !readFileSync(COMPILED_PRELOAD, "utf8").includes(COMPILED_PRELOAD_MARKER)) {
    const built = Bun.spawnSync([process.execPath, join(DEVKIT_DIR, "api", "preload", "build.ts")], {
      cwd: join(DEVKIT_DIR, "api", "preload"),
      stdout: "inherit",
      stderr: "inherit",
    });
    if (built.exitCode !== 0) throw new Error("Could not compile the patched Electrobun preload");
    if (!readFileSync(COMPILED_PRELOAD, "utf8").includes(COMPILED_PRELOAD_MARKER)) {
      throw new Error("The compiled Electrobun preload does not have the patched source");
    }
    changed.push("api/preload/.generated/compiled.ts");
  }
  return changed;
}

if (import.meta.main) {
  const changed = await patchElectrobunDevkit();
  console.log(changed.length > 0 ? `Patched the Electrobun SDK: ${changed.join(", ")}` : "The Electrobun SDK is already patched");
}
