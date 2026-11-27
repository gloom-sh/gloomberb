import { decodePositionsFile, MAX_POSITIONS_FILE_BYTES } from "../../../../portfolio/positions-import/parse";
import { expandHomePath, loadNodeFileModules } from "../../../../utils/node-file-read";

/**
 * Reads a positions file the terminal was given as a path. Node modules load
 * at run time, so the web and desktop bundles, which pick the file with the
 * system dialog, never pull them in.
 */
export async function readPositionsFilePath(rawPath: string): Promise<{ text: string; name: string }> {
  const { fs, homedir, basename } = await loadNodeFileModules();
  const unquoted = rawPath.trim().replace(/^(['"])(.*)\1$/, "$2");
  const resolved = expandHomePath(unquoted, homedir);
  let size: number;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error(`${unquoted} is not a file.`);
    size = stat.size;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") throw new Error(`No file at ${unquoted}.`);
    throw error;
  }
  if (size > MAX_POSITIONS_FILE_BYTES) throw new Error(`${unquoted} is too large to be a positions export.`);
  return { text: decodePositionsFile(await fs.readFile(resolved)), name: basename(resolved) };
}
