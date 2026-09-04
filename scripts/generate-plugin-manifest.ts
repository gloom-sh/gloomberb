import { buildBuiltinManifest } from "../src/plugins/catalog-manifest";

/**
 * Writes `plugin-manifest.json`, the published description of Gloomberb's
 * built-in plugins. The plugin directory reads it so the built-in half of the
 * catalog comes from this repository rather than a hand-kept copy elsewhere.
 *
 * Run with --check in CI to fail when the committed file no longer matches the
 * live catalog.
 */
const OUT = new URL("../plugin-manifest.json", import.meta.url);

const manifest = buildBuiltinManifest();

if (manifest.uncategorised.length > 0) {
  console.error(
    `Built-in plugins missing editorial metadata: ${manifest.uncategorised.join(", ")}\n` +
      "Add them to EDITORIAL in src/plugins/catalog-manifest.ts so they are not listed uncategorised.",
  );
  process.exit(1);
}

// A declared icon that is not in the repo resolves to a 404 in the directory,
// which renders as a broken tile rather than falling back to a glyph.
const missingIcons = await Promise.all(
  manifest.plugins
    .map((plugin) => plugin.icon)
    .filter((icon): icon is string => !!icon)
    .map(async (icon) => ({
      icon,
      exists: await Bun.file(new URL(`../${icon}`, import.meta.url)).exists(),
    })),
).then((results) => results.filter((result) => !result.exists));

if (missingIcons.length > 0) {
  console.error(
    `Plugin icons declared in EDITORIAL but missing from the repo: ${missingIcons
      .map((result) => result.icon)
      .join(", ")}`,
  );
  process.exit(1);
}

const { uncategorised: _drop, ...published } = manifest;
const next = `${JSON.stringify(published, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await Bun.file(OUT).text().catch(() => "");
  if (current !== next) {
    console.error(
      "plugin-manifest.json is out of date with the plugin catalog.\n" +
        "Run: bun run plugins:manifest",
    );
    process.exit(1);
  }
  console.log(`plugin-manifest.json is current (${published.plugins.length} built-in plugins).`);
} else {
  await Bun.write(OUT, next);
  console.log(`Wrote plugin-manifest.json (${published.plugins.length} built-in plugins).`);
}
