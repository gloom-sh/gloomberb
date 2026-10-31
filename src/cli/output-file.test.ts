import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { checkOutputPath, createOutputFolder, resolveOutputPath, writeOutputFile } from "./output-file";

test("--output reads every path form a shell passes, and a Windows path only on Windows", () => {
  const posix = { cwd: "/work", home: "/home/me", platform: "linux" as const };
  expect(resolveOutputPath("rv.csv", posix)).toBe("/work/rv.csv");
  expect(resolveOutputPath("../out/rv.csv", posix)).toBe("/out/rv.csv");
  expect(resolveOutputPath("/tmp/rv.csv", posix)).toBe("/tmp/rv.csv");
  // A shell leaves `~` as typed after `--output=`.
  expect(resolveOutputPath("~/Desktop/screen.csv", posix)).toBe("/home/me/Desktop/screen.csv");
  expect(resolveOutputPath("  My Screens/eqs.csv ", posix)).toBe("/work/My Screens/eqs.csv");
  expect(() => resolveOutputPath("C:\\Users\\me\\Desktop\\screen.csv", posix)).toThrow("is a Windows path");
  expect(() => resolveOutputPath(" ", posix)).toThrow("--output needs a file");

  const windows = { cwd: "C:\\work", home: "C:\\Users\\me", platform: "win32" as const };
  expect(resolveOutputPath("C:\\Users\\me\\Desktop\\screen.csv", windows)).toBe("C:\\Users\\me\\Desktop\\screen.csv");
  expect(resolveOutputPath("C:/Users/me/screen.csv", windows)).toBe("C:\\Users\\me\\screen.csv");
  expect(resolveOutputPath("out\\rv.csv", windows)).toBe("C:\\work\\out\\rv.csv");
  expect(resolveOutputPath("~\\Desktop\\rv.csv", windows)).toBe("C:\\Users\\me\\Desktop\\rv.csv");
});

test("an output folder that cannot be created is named, not left to mkdir's words", async () => {
  const root = await mkdtemp(join(tmpdir(), "gloom-output-folder-"));
  try {
    // A file where a folder of the path would go.
    await writeFile(join(root, "taken"), "");
    const blocked = join(root, "taken", "shots");
    await expect(createOutputFolder(join(blocked, "x.png"))).rejects.toThrow(`Cannot create the folder ${blocked}: a file stands where one of its folders would be.`);
    await expect(writeOutputFile(join(blocked, "x.csv"), "a,b\n")).rejects.toThrow(`Cannot create the folder ${blocked}:`);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = join(root, "locked");
      await mkdir(locked, { mode: 0o500 });
      await expect(createOutputFolder(join(locked, "new", "x.png"))).rejects.toThrow(`Cannot create the folder ${join(locked, "new")}: permission denied.`);
      await chmod(locked, 0o700);
    }
    await createOutputFolder(join(root, "made", "deep", "x.png"));
    expect((await stat(join(root, "made", "deep"))).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A report can hold positions and balances; `--output` naming a link or a device must not write through it.
test.skipIf(process.platform === "win32")("--output writes a plain file only the user can read, and nothing through a link or into a device", async () => {
  const root = await mkdtemp(join(tmpdir(), "gloom-output-file-"));
  try {
    const fresh = join(root, "report.csv");
    await writeOutputFile(fresh, "a,b\n");
    expect((await stat(fresh)).mode & 0o777).toBe(0o600);
    // A file it replaces is made private before the report goes in, and holds only the report.
    const shared = join(root, "shared.csv");
    await writeFile(shared, "an older and longer report\n", { mode: 0o644 });
    await chmod(shared, 0o644);
    await writeOutputFile(shared, "x\n");
    expect((await stat(shared)).mode & 0o777).toBe(0o600);
    expect(await readFile(shared, "utf8")).toBe("x\n");

    const target = join(root, "elsewhere.txt");
    await writeFile(target, "untouched");
    const link = join(root, "link.csv");
    await symlink(target, link);
    const dangling = join(root, "dangling.csv");
    await symlink(join(root, "missing.txt"), dangling);
    const pipe = join(root, "pipe.csv");
    expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
    for (const [path, reason] of [[link, "it is a link"], [dangling, "it is a link"], [pipe, "it is not a plain file"], ["/dev/null", "it is not a plain file"]] as const) {
      await expect(checkOutputPath(path)).rejects.toThrow(`Cannot write ${path}: ${reason}`);
      await expect(writeOutputFile(path, "a,b\n")).rejects.toThrow(`Cannot write ${path}: ${reason}`);
    }
    expect(await readFile(target, "utf8")).toBe("untouched");
    await expect(lstat(join(root, "missing.txt"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
