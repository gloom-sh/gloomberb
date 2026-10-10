import { appendFile } from "fs/promises";
import { join } from "path";

/**
 * Whether a change touches what the pane chrome checks cover: the
 * pull_request paths of .github/workflows/pane-chrome.yml, and any extra
 * globs given. Prints the files that match and, in GitHub Actions, writes
 * `relevant=true` or `relevant=false` to the step's outputs.
 *
 *   bun run scripts/pane-chrome/scope.ts <base ref> [extra glob ...]
 */

const [base, ...extra] = process.argv.slice(2);
if (!base) throw new Error("Usage: scope.ts <base ref> [extra glob ...]");
const workflow = Bun.YAML.parse(await Bun.file(join(import.meta.dir, "../../.github/workflows/pane-chrome.yml")).text()) as {
  on: { pull_request: { paths: string[] } };
};
const globs = [...workflow.on.pull_request.paths, ...extra].map((pattern) => new Bun.Glob(pattern));
const diff = Bun.spawnSync(["git", "diff", "--name-only", base, "HEAD"]);
if (diff.exitCode !== 0) throw new Error(`git diff failed: ${diff.stderr.toString()}`);
const changed = diff.stdout.toString().split("\n").filter(Boolean);
const matching = changed.filter((file) => globs.some((glob) => glob.match(file)));
console.log(matching.length > 0
  ? `${matching.length} of ${changed.length} changed files touch pane chrome:\n${matching.join("\n")}`
  : `None of the ${changed.length} changed files touch pane chrome.`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `relevant=${matching.length > 0}\n`);
