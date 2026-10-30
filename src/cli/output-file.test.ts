import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createOutputFolder, resolveOutputPath, writeOutputFile } from "./output-file";

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
