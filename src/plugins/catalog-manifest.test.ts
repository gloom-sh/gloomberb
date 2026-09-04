import { describe, expect, test } from "bun:test";

import { buildBuiltinManifest } from "./catalog-manifest";

/**
 * The published manifest is the built-in half of the plugin directory. It used
 * to be hand-maintained in a separate repository, where it drifted from the
 * real catalog with nothing to catch it: a built-in could rename itself, gain a
 * pane, or be added outright, and the directory would keep showing the old
 * description indefinitely.
 *
 * These tests exist so that cannot recur. Drift now fails here rather than
 * being discovered by a user reading a stale listing.
 */
describe("built-in plugin manifest", () => {
  test("matches the committed file, so the directory cannot serve a stale catalog", async () => {
    const committed = JSON.parse(
      await Bun.file(new URL("../../plugin-manifest.json", import.meta.url)).text(),
    );
    const { uncategorised: _drop, ...generated } = buildBuiltinManifest();

    expect(generated).toEqual(committed);
  });

  test("every built-in has editorial metadata", () => {
    // A new built-in with no categories would appear unfiltered and
    // uncategorised in the directory, so generation refuses instead.
    expect(buildBuiltinManifest().uncategorised).toEqual([]);
  });

  test("exactly one plugin is featured", () => {
    const featured = buildBuiltinManifest().plugins.filter((plugin) => plugin.featured);

    expect(featured.map((plugin) => plugin.id)).toEqual(["gloomberb-cloud"]);
  });

  test("every declared icon exists in the repo", async () => {
    // The directory resolves these against this repo's HEAD, so a wrong path
    // is a broken image in the plugin grid rather than a missing file here.
    const icons = buildBuiltinManifest()
      .plugins.map((plugin) => plugin.icon)
      .filter((icon): icon is string => !!icon);

    expect(icons.length).toBeGreaterThan(0);

    for (const icon of icons) {
      const file = Bun.file(new URL(`../../${icon}`, import.meta.url));
      expect(await file.exists()).toBe(true);
    }
  });

  test("describes what each plugin contributes, which is what the directory renders", () => {
    const cloud = buildBuiltinManifest().plugins.find((plugin) => plugin.id === "gloomberb-cloud");

    expect(cloud?.contributes.panes).toContain("chat");
    expect(cloud?.contributes.capabilities.length).toBeGreaterThan(0);
  });
});
