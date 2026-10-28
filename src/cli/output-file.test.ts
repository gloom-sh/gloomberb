import { expect, test } from "bun:test";
import { resolveOutputPath } from "./output-file";

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
