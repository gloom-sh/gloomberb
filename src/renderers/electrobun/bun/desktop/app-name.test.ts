import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeLegacyMacApp, renameLegacyMacApp, type MacAppNameOptions } from "./app-name";

// These move and delete app bundles and rewrite the user's command links, so
// each case checks what is on disk afterwards, not only what was returned.
let root = "";
let applications = "";
let home = "";
let localBin = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gloom-app-name-"));
  applications = join(root, "Applications");
  home = join(root, "home");
  localBin = join(home, ".local", "bin");
  mkdirSync(applications, { recursive: true });
  mkdirSync(localBin, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A desktop build's bundle as Electrobun lays it out, with the two terminal commands. */
function bundle(name: string, { identifier = "com.vincelwt.gloomberb", version = "0.19.0" } = {}): string {
  const path = join(applications, name);
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(path, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(path, "Contents", "MacOS", "bun"), "");
  writeFileSync(join(path, "Contents", "Resources", "version.json"), JSON.stringify({ version, identifier, name: name.replace(/\.app$/, "") }));
  for (const command of ["gloom", "gloomberb"]) writeFileSync(join(path, "Contents", "Resources", command), "#!/bin/sh\n");
  return path;
}

function options(running: string, extra: Partial<MacAppNameOptions> = {}): MacAppNameOptions {
  return {
    execPath: join(running, "Contents", "MacOS", "bun"),
    platform: "darwin",
    homeDir: home,
    pathEnv: "",
    homebrewPrefixes: [join(root, "homebrew")],
    homebrewBins: [],
    ...extra,
  };
}

/** The links install.sh makes: absolute, into the app's Resources. */
function installScriptLinks(app: string): void {
  symlinkSync(join(app, "Contents", "Resources", "gloom"), join(localBin, "gloom"));
  symlinkSync(join(app, "Contents", "Resources", "gloomberb"), join(localBin, "gloomberb"));
}

describe("an install from before the rename, after its updater put the new build in Gloomberb.app", () => {
  test("takes the name Gloom.app and moves the install script's command links with it", async () => {
    const legacy = bundle("Gloomberb.app");
    installScriptLinks(legacy);
    // A relative link, as someone may write by hand, stays relative.
    const handBin = join(home, "bin");
    mkdirSync(handBin);
    symlinkSync("../../Applications/Gloomberb.app/Contents/Resources/gloom", join(handBin, "gloom"));

    const result = await renameLegacyMacApp(options(legacy));

    const renamed = join(applications, "Gloom.app");
    expect(result).toEqual({
      kind: "renamed",
      bundle: renamed,
      relinked: [join(localBin, "gloom"), join(localBin, "gloomberb"), join(handBin, "gloom")],
    });
    expect(readdirSync(applications)).toEqual(["Gloom.app"]);
    expect(readlinkSync(join(localBin, "gloom"))).toBe(join(renamed, "Contents", "Resources", "gloom"));
    expect(readlinkSync(join(localBin, "gloomberb"))).toBe(join(renamed, "Contents", "Resources", "gloomberb"));
    expect(readlinkSync(join(handBin, "gloom"))).toBe("../../Applications/Gloom.app/Contents/Resources/gloom");
    // Every command still reaches a file.
    for (const link of [join(localBin, "gloom"), join(localBin, "gloomberb"), join(handBin, "gloom")]) {
      expect(readFileSync(link, "utf8")).toBe("#!/bin/sh\n");
    }
    expect(readdirSync(localBin).sort()).toEqual(["gloom", "gloomberb"]);
  });

  test("replaces a Gloom.app of this app already there with the running build", async () => {
    const legacy = bundle("Gloomberb.app", { version: "0.19.1" });
    bundle("Gloom.app", { version: "0.19.0" });

    const result = await renameLegacyMacApp(options(legacy));

    expect(result.kind).toBe("renamed");
    expect(readdirSync(applications)).toEqual(["Gloom.app"]);
    expect(JSON.parse(readFileSync(join(applications, "Gloom.app", "Contents", "Resources", "version.json"), "utf8")).version).toBe("0.19.1");
  });

  test("keeps the old name under Homebrew, beside another program's Gloom.app, and when a link cannot follow", async () => {
    const legacy = bundle("Gloomberb.app");

    mkdirSync(join(root, "homebrew", "Caskroom", "gloomberb"), { recursive: true });
    expect(await renameLegacyMacApp(options(legacy))).toEqual({ kind: "skipped", reason: "homebrew" });
    rmSync(join(root, "homebrew"), { recursive: true });

    const other = bundle("Gloom.app", { identifier: "com.example.gloom" });
    expect(await renameLegacyMacApp(options(legacy))).toEqual({ kind: "skipped", reason: "name-taken" });
    rmSync(other, { recursive: true });

    if (process.getuid?.() !== 0) {
      installScriptLinks(legacy);
      chmodSync(localBin, 0o555);
      try {
        expect(await renameLegacyMacApp(options(legacy))).toEqual({ kind: "skipped", reason: "command-folder-not-writable" });
      } finally {
        chmodSync(localBin, 0o755);
      }
      expect(readlinkSync(join(localBin, "gloom"))).toBe(join(legacy, "Contents", "Resources", "gloom"));
    }

    expect(await renameLegacyMacApp(options(legacy, { execPath: join("/Volumes/Gloom", "Gloomberb.app", "Contents", "MacOS", "bun") })))
      .toEqual({ kind: "skipped", reason: "read-only-location" });
    expect(readdirSync(applications)).toEqual(["Gloomberb.app"]);
  });

  test("does nothing for the new name, a development build or another platform", async () => {
    const renamed = bundle("Gloom.app");
    const dev = bundle("Gloomberb-dev.app");
    expect(await renameLegacyMacApp(options(renamed))).toEqual({ kind: "none" });
    expect(await renameLegacyMacApp(options(dev))).toEqual({ kind: "none" });
    expect(await renameLegacyMacApp(options(join(applications, "Gloomberb.app"), { platform: "win32" }))).toEqual({ kind: "none" });
    expect(readdirSync(applications).sort()).toEqual(["Gloom.app", "Gloomberb-dev.app"]);
  });
});

describe("Gloom.app with a Gloomberb.app beside it", () => {
  test("removes the old copy once its command links lead to the running app", async () => {
    const running = bundle("Gloom.app");
    const legacy = bundle("Gloomberb.app", { version: "0.18.4" });
    installScriptLinks(legacy);

    expect(await removeLegacyMacApp(options(running))).toBe(legacy);

    expect(readdirSync(applications)).toEqual(["Gloom.app"]);
    expect(readlinkSync(join(localBin, "gloom"))).toBe(join(running, "Contents", "Resources", "gloom"));
    expect(readlinkSync(join(localBin, "gloomberb"))).toBe(join(running, "Contents", "Resources", "gloomberb"));
  });

  test("leaves another program's Gloomberb.app and a Homebrew one alone", async () => {
    const running = bundle("Gloom.app");
    bundle("Gloomberb.app", { identifier: "com.example.other" });
    expect(await removeLegacyMacApp(options(running))).toBeNull();

    rmSync(join(applications, "Gloomberb.app"), { recursive: true });
    bundle("Gloomberb.app");
    mkdirSync(join(root, "homebrew", "Caskroom", "gloomberb"), { recursive: true });
    expect(await removeLegacyMacApp(options(running))).toBeNull();
    expect(existsSync(join(applications, "Gloomberb.app"))).toBe(true);
  });
});
