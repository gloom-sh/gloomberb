import { decodePositionsFile, MAX_POSITIONS_FILE_BYTES } from "../../../../portfolio/positions-import/parse";

type NodeFs = typeof import("fs/promises");

/**
 * Reads a positions file the terminal was given as a path. Node modules load
 * at run time, so the web and desktop bundles, which pick the file with the
 * system dialog, never pull them in.
 */
export async function readPositionsFilePath(rawPath: string): Promise<{ text: string; name: string }> {
  const fsModulePath = "fs/promises";
  const osModulePath = "os";
  const pathModulePath = "path";
  const [fs, os, path] = await Promise.all([
    import(fsModulePath) as Promise<NodeFs>,
    import(osModulePath) as Promise<typeof import("os")>,
    import(pathModulePath) as Promise<typeof import("path")>,
  ]);
  const unquoted = rawPath.trim().replace(/^(['"])(.*)\1$/, "$2");
  const resolved = unquoted === "~" || unquoted.startsWith("~/") ? `${os.homedir()}${unquoted.slice(1)}` : unquoted;
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
  return { text: decodePositionsFile(await fs.readFile(resolved)), name: path.basename(resolved) };
}
