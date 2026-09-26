import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tempPaths: string[] = [];

/** A fresh SQLite path under the OS temp dir. Pair with `afterEach(removeTempDbFiles)`. */
export function createTempDbPath(name: string): string {
  const path = join(tmpdir(), `gloomberb-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tempPaths.push(path);
  return path;
}

/** Deletes every database created since the last call, with its WAL and shared-memory files. */
export function removeTempDbFiles(): void {
  for (const path of tempPaths.splice(0)) {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
  }
}
