import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = Bun.YAML.parse(
  readFileSync(resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8"),
) as { jobs: { "publish-terminal": { steps: { name?: string; run?: string }[] } } };
const check = workflow.jobs["publish-terminal"].steps.find((step) => step.name === "Check the tag")!;

test.each([
  ["refs/tags/v0.19.0", "v0.19.0", 0],
  ["refs/heads/main", "v0.19.0", 1],
  ["refs/heads/v0.19.0", "v0.19.0", 1],
  ["refs/tags/v0.19.1", "v0.19.0", 1],
  ["refs/tags/v0.19.0-nightly.1", "v0.19.0-nightly.1", 1],
  ["refs/tags/other", "other", 1],
])("npm recovery at %s for %s exits %i", (ref, tag, exitCode) => {
  const result = Bun.spawnSync(["bash", "-e", "-c", check.run!], {
    env: { PATH: process.env.PATH!, GITHUB_REF: ref as string, TAG: tag as string },
    timeout: 5_000,
  });
  expect(result.exitCode).toBe(exitCode);
  if (ref !== `refs/tags/${tag}`) {
    expect(result.stderr.toString()).toContain(`--ref ${tag} -f tag=${tag}`);
  }
});
