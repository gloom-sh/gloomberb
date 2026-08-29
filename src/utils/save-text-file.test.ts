import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTextFileToDirectory } from "./save-text-file";

let directory: string | null = null;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

test("keeps existing exports instead of overwriting them", async () => {
  directory = await mkdtemp(join(tmpdir(), "gloomberb-export-"));

  const first = await saveTextFileToDirectory(directory, "prices.csv", "first");
  const second = await saveTextFileToDirectory(directory, "prices.csv", "second");

  expect(first).toBe("prices.csv");
  expect(second).toBe("prices (2).csv");
  expect(await readFile(join(directory, first), "utf-8")).toBe("first");
  expect(await readFile(join(directory, second), "utf-8")).toBe("second");
});
