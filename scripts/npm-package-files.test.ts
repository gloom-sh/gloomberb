import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const SNAPSHOT = "src/cli/pane-functions/catalog-snapshot.json";

/**
 * The release job copies the catalog snapshot into the checkout before `npm publish`, and git ignores it. Whether the
 * package then carries it is up to the `files` list and the ignore rule, which a scratch package with the repository's
 * own package.json and .gitignore settles without writing into the checkout.
 */
test("npm pack ships the catalog snapshot a release writes, though git ignores it", () => {
  const parent = join(homedir(), ".cache", "gloom-smoke");
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, "npm-package-files-"));
  try {
    for (const file of ["package.json", ".gitignore"]) copyFileSync(join(root, file), join(scratch, file));
    mkdirSync(join(scratch, "src/cli/pane-functions"), { recursive: true });
    for (const file of [SNAPSHOT, "src/cli/pane-functions/catalog-snapshot.ts", "src/cli/pane-functions/catalog-snapshot.test.ts"]) {
      writeFileSync(join(scratch, file), "{}\n");
    }
    const packed = Bun.spawnSync(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: scratch, stdout: "pipe", stderr: "pipe", env: { ...process.env, npm_config_update_notifier: "false" },
    });
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);
    const files = (JSON.parse(packed.stdout.toString()) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((file) => file.path);
    expect(files).toContain(SNAPSHOT);
    // The scratch package follows the `files` list as the real one does: a source file ships, a test does not.
    expect(files).toContain("src/cli/pane-functions/catalog-snapshot.ts");
    expect(files).not.toContain("src/cli/pane-functions/catalog-snapshot.test.ts");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
