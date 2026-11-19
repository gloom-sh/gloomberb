import { rmSync } from "fs";
import { join } from "path";

const rootDir = join(import.meta.dir, "..");
const CATALOG_SNAPSHOT_FILE = join(rootDir, "src", "cli", "pane-functions", "catalog-snapshot.json");

/**
 * Writes the catalog snapshot (`bun run catalog:snapshot`) beside the terminal's sources, for the bundle or binary
 * built next to carry: `catalog` and `fn` then say what the built-in plugins are without loading them. Returns the
 * exit code of the generator. The file is not in git; `removeCatalogSnapshot` takes it away once the build is done.
 */
export function writeCatalogSnapshot(options: { quiet?: boolean } = {}): number {
  const written = Bun.spawnSync({
    cmd: [process.execPath, "run", join(rootDir, "scripts", "update-cli-catalog-snapshot.ts")],
    cwd: rootDir,
    stdout: options.quiet ? "ignore" : "inherit",
    stderr: "inherit",
  });
  return written.exitCode ?? 1;
}

/** So a checkout never keeps a snapshot that the plugins later move away from. */
export function removeCatalogSnapshot(): void {
  rmSync(CATALOG_SNAPSHOT_FILE, { force: true });
}
