type NodeFs = typeof import("fs/promises");

/** Loaded at run time, so the web and desktop view bundles never pull in Node modules. */
export async function loadNodeFileModules(): Promise<{
  fs: NodeFs;
  homedir: () => string;
  basename: (filePath: string) => string;
}> {
  const fsModulePath = "fs/promises";
  const osModulePath = "os";
  const pathModulePath = "path";
  const [fs, os, path] = await Promise.all([
    import(fsModulePath) as Promise<NodeFs>,
    import(osModulePath) as Promise<typeof import("os")>,
    import(pathModulePath) as Promise<typeof import("path")>,
  ]);
  return { fs, homedir: os.homedir, basename: path.basename };
}

export function expandHomePath(filePath: string, homedir: () => string): string {
  return filePath === "~" || filePath.startsWith("~/") ? `${homedir()}${filePath.slice(1)}` : filePath;
}
