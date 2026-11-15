import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Permissions = string | Record<string, string> | undefined;
interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Workflow {
  permissions?: Permissions;
  jobs: Record<string, { permissions?: Permissions; steps?: Step[] }>;
}

function workflow(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(resolve(import.meta.dir, `../.github/workflows/${name}.yml`), "utf8")) as Workflow;
}

function writes(permissions: Permissions, scope: string): boolean {
  return permissions === "write-all" || (typeof permissions === "object" && permissions[scope] === "write");
}

const release = workflow("release");
const nightly = workflow("nightly");
const build = workflow("build-release-assets");

const check = release.jobs["publish-terminal"]!.steps!.find((step) => step.name === "Check the tag")!;

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

// The jobs that publish trust a file only when an attestation signed as
// build-release-assets.yml names it. A job that runs registry plugins and could
// sign one would make that check worthless.
test("only the build jobs can sign attestations, and never the job that runs registry plugins", () => {
  for (const [name, caller] of [["release", release], ["nightly", nightly]] as const) {
    for (const [job, { permissions }] of Object.entries(caller.jobs)) {
      expect({ job: `${name}/${job}`, attests: writes(permissions ?? caller.permissions, "attestations") })
        .toEqual({ job: `${name}/${job}`, attests: job === "build" });
    }
    const plugins = caller.jobs["registry-plugins"]!.permissions ?? caller.permissions;
    expect(writes(plugins, "id-token")).toBe(false);
  }
  const load = workflow("load-registry-plugins");
  for (const permissions of [load.permissions, ...Object.values(load.jobs).map((job) => job.permissions)]) {
    expect(writes(permissions, "id-token") || writes(permissions, "attestations")).toBe(false);
  }
});

test("each build job attests the files it uploads for publishing right before the upload, which runs only when every step passed", () => {
  for (const [job, { permissions, steps = [] }] of Object.entries(build.jobs)) {
    expect({ job, permissions }).toMatchObject({ job, permissions: { "id-token": "write", attestations: "write" } });
    const uploads = steps.flatMap((step, index) => (step.uses?.startsWith("actions/upload-artifact@") ? [{ step, index }] : []));
    // The jobs that publish download gloomberb-* only; the build matrix names its assets gloomberb-*.
    const published = uploads.filter(({ step }) => /^(gloomberb-|\$\{\{ matrix\.asset \}\}$)/.test(String(step.with?.name)));
    expect({ job, published: published.length }).toEqual({ job, published: 1 });
    const { step: upload, index } = published[0]!;
    const attest = steps[index - 1]!;
    expect({ job, attest: attest.uses?.split("@")[0], subject: attest.with?.["subject-path"], if: attest.if, uploadIf: upload.if })
      .toEqual({ job, attest: "actions/attest", subject: upload.with?.path, if: undefined, uploadIf: undefined });
  }
});

test("the jobs that publish download only the builds and check every file before anything uploads", () => {
  for (const [name, steps, upload] of [
    ["release", release.jobs.release!.steps!, "upload"],
    ["nightly", nightly.jobs.publish!.steps!, "draft"],
  ] as const) {
    const download = steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@"));
    const checked = steps.findIndex((step) => step.run === "bun scripts/check-built-files.ts dist");
    const uploaded = steps.findIndex((step) => step.id === upload);
    expect({ name, pattern: steps[download]!.with?.pattern, checkIf: steps[checked]?.if })
      .toEqual({ name, pattern: "gloomberb-*", checkIf: undefined });
    expect(download).toBeLessThan(checked);
    expect(checked).toBeLessThan(uploaded);
    expect(steps.filter((step) => step.uses?.startsWith("actions/download-artifact@"))).toHaveLength(1);
  }
});

test("the Windows installer is built with a pinned Inno Setup", () => {
  const install = build.jobs["desktop-windows"]!.steps!.find((step) => step.name === "Install Inno Setup")!;
  expect(install.env?.INNO_SETUP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(install.run).toContain("choco install innosetup --version $env:INNO_SETUP_VERSION ");
});
