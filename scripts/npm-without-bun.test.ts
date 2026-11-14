import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const binDir = join(import.meta.dir, "..", "bin");
const withoutBun = createRequire(import.meta.url)(join(binDir, "without-bun.cjs")) as {
  useNodeWithoutBun(launcher: string, env: Record<string, string | undefined>, platform?: string): boolean;
};
const node = Bun.which("node");

function scratch(): string {
  const parent = join(homedir(), ".cache", "gloom-smoke");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "npm-without-bun-"));
}

/** The installed package's bin folder: the launcher, its helper, and a package.json that makes it ESM, as npm leaves it. */
function installedBin(root: string): string {
  const pkg = join(root, "node_modules", "@gloom-sh", "terminal");
  const bin = join(pkg, "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(binDir, "gloom"), join(bin, "gloom"));
  copyFileSync(join(binDir, "without-bun.cjs"), join(bin, "without-bun.cjs"));
  chmodSync(join(bin, "gloom"), 0o755);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module" }));
  return join(bin, "gloom");
}

// npm and npx installed the command on machines without Bun, where its `#!/usr/bin/env bun` line failed with
// "env: bun: No such file or directory" before any of Gloom ran.
describe("an npm install without Bun", () => {
  test("points the command at Node only when no Bun is found, and leaves Bun's line otherwise", () => {
    const root = scratch();
    try {
      const launcher = installedBin(root);
      const fakeBun = join(root, "fake-bun");
      mkdirSync(fakeBun);
      writeFileSync(join(fakeBun, "bun"), "");
      const noBun = { PATH: join(root, "empty"), BUN_INSTALL: join(root, "none") };
      expect(withoutBun.useNodeWithoutBun(launcher, { ...noBun, PATH: fakeBun }, "linux")).toBe(false);
      expect(withoutBun.useNodeWithoutBun(launcher, { ...noBun, npm_config_user_agent: "bun/1.3.14 npm/? node/v24.3.0" }, "linux")).toBe(false);
      // A source checkout, as a contributor's `npm install` would run it.
      const checkout = join(root, "checkout-gloom");
      copyFileSync(join(binDir, "gloom"), checkout);
      expect(withoutBun.useNodeWithoutBun(checkout, noBun, "linux")).toBe(false);
      expect(readFileSync(launcher, "utf8").split("\n")[0]).toBe("#!/usr/bin/env bun");
      expect(withoutBun.useNodeWithoutBun(launcher, noBun, "linux")).toBe(true);
      const text = readFileSync(launcher, "utf8");
      expect(text.split("\n")[0]).toBe("#!/usr/bin/env node");
      // The rest of the launcher is as shipped.
      const shipped = readFileSync(join(binDir, "gloom"), "utf8");
      expect(text.slice(text.indexOf("\n"))).toBe(shipped.slice(shipped.indexOf("\n")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!node)("the command under Node says in one line how to get Bun", () => {
    const root = scratch();
    try {
      const launcher = installedBin(root);
      const run = Bun.spawnSync([node!, launcher, "--version"], {
        env: { PATH: "/usr/bin:/bin", HOME: root, GLOOMBERB_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode).toBe(1);
      expect(run.stdout.toString()).toBe("");
      const lines = run.stderr.toString().trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("gloom runs on Bun, which is not installed.");
      expect(lines[0]).toContain("curl -fsSL https://gloom.sh/install | bash");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
