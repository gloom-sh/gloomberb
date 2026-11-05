import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { checkoutRegistryPlugin } from "./registry-plugins";

const root = mkdtempSync(join(tmpdir(), "gloom-registry-checkout-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A plugin whose first commit is the one the registry reviewed, and whose
// default branch has moved on since.
const source = join(root, "source");
git(["init", "--quiet", "--initial-branch=main", source], root);
const commit = (message: string) => {
  git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "--allow-empty", "-m", message], source);
  return git(["rev-parse", "HEAD"], source);
};
const reviewed = commit("reviewed");
commit("not reviewed");
const url = `file://${source}`;

let checkouts = 0;
const nextDir = () => join(root, `checkout-${++checkouts}`);

describe("checkoutRegistryPlugin", () => {
  test("lands on the commit the registry reviewed, whatever the default branch holds now", () => {
    const dir = nextDir();
    checkoutRegistryPlugin({ ref: "main", commit: reviewed.toUpperCase() }, url, dir);
    expect(git(["rev-parse", "HEAD"], dir)).toBe(reviewed);
  });

  test("refuses an abbreviated commit, and leaves nothing behind when the commit is not there", () => {
    const abbreviated = nextDir();
    expect(() => checkoutRegistryPlugin({ ref: "main", commit: reviewed.slice(0, 7) }, url, abbreviated)).toThrow("full 40-character");
    expect(existsSync(abbreviated)).toBe(false);

    const missing = nextDir();
    expect(() => checkoutRegistryPlugin({ commit: "1".repeat(40) }, url, missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});
