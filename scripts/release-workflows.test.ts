import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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
    // The jobs that publish download gloomberb-* and the catalog snapshot only; the build matrix names its assets gloomberb-*.
    const published = uploads.filter(({ step }) => /^(gloomberb-|catalog-snapshot$|\$\{\{ matrix\.asset \}\}$)/.test(String(step.with?.name)));
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
    // The release also takes the snapshot the npm package carries, a file of its own that no release asset or nightly
    // file shares a folder with, matched to its attestation before anything is uploaded or published to npm: a
    // snapshot that fails that leaves the draft a draft instead of a release with no package.
    const downloads = steps.filter((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(downloads.map((step) => step.with?.pattern ?? step.with?.name)).toEqual(name === "release" ? ["gloomberb-*", "catalog-snapshot"] : ["gloomberb-*"]);
    if (name === "release") {
      const snapshot = steps.indexOf(downloads[1]!);
      const snapshotChecked = steps.findIndex((step) => step.run === "bun scripts/check-built-files.ts catalog-snapshot");
      const copied = steps.findIndex((step) => step.run?.startsWith("cp catalog-snapshot/catalog-snapshot.json "));
      const publishes = steps.flatMap((step, position) => (step.run?.includes("npm publish") ? [position] : []));
      expect(publishes.length).toBeGreaterThan(0);
      expect(steps[snapshotChecked]?.if).toBeUndefined();
      expect(snapshot).toBeLessThan(snapshotChecked);
      expect(snapshotChecked).toBeLessThan(uploaded);
      expect(snapshotChecked).toBeLessThan(copied);
      for (const position of publishes) expect(copied).toBeLessThan(position);
    }
  }
});

// A step gated on an output nobody sets never runs, and the nightly would quietly stop publishing.
test("the nightly rechecks main's workflows right before the draft, and only the steps that create or publish one wait on it", () => {
  const steps = nightly.jobs.publish!.steps!;
  const recheck = steps.findIndex((step) => step.id === "workflows");
  expect(steps[recheck]?.run).toBe("bun run scripts/nightly.ts check-workflows");
  expect(steps[recheck]?.if).toBeUndefined();
  expect(steps.findIndex((step) => step.id === "draft")).toBe(recheck + 1);

  // The cleanup of a failed draft is the one step that must not wait on it.
  const after = steps.slice(recheck + 1).filter((step) => step.run !== "bun run scripts/nightly.ts drop-draft");
  expect(after.map((step) => step.name)).toEqual(["Upload the draft", "Publish the prerelease", "Prune old nightly builds"]);
  for (const step of after) {
    expect({ name: step.name, if: step.if }).toEqual({ name: step.name, if: "${{ steps.workflows.outputs.current == 'true' }}" });
  }
});

// The release and every check that builds the Windows installer compile it
// with the one pinned Inno Setup, so no check passes on a compiler the
// release does not ship with.
test("every job that builds the Windows installer installs the pinned Inno Setup first, and nothing installs another", () => {
  const action = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, "../.github/actions/inno-setup/action.yml"), "utf8")) as { runs: { steps: Step[] } };
  const install = action.runs.steps.find((step) => step.run?.includes("choco install innosetup"))!;
  expect(install.env?.INNO_SETUP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(install.run).toContain("choco install innosetup --version $env:INNO_SETUP_VERSION ");

  const builders: string[] = [];
  for (const file of readdirSync(resolve(import.meta.dir, "../.github/workflows")).filter((name) => name.endsWith(".yml"))) {
    for (const [job, { steps = [] }] of Object.entries(workflow(file.slice(0, -".yml".length)).jobs)) {
      const where = `${file} ${job}`;
      const installs = steps.filter((step) => /\binnosetup\b|\biscc(\.exe)?\b/i.test(step.run ?? ""));
      expect({ where, installs }).toEqual({ where, installs: [] });
      const built = steps.findIndex((step) => step.run?.includes("build-windows-installer.ps1"));
      if (built === -1) continue;
      builders.push(where);
      const pinned = steps.findIndex((step) => step.uses === "./.github/actions/inno-setup");
      expect({ where, pinnedFirst: pinned !== -1 && pinned < built }).toEqual({ where, pinnedFirst: true });
    }
  }
  expect(builders).toEqual(expect.arrayContaining([
    "build-release-assets.yml desktop-windows",
    "desktop-shell-check.yml windows",
    "verify-windows.yml desktop",
    "windows-desktop-check.yml build",
  ]));
});
