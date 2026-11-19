import { expect, test } from "bun:test";
import { existsSync } from "fs";
import { withShotTempDir } from "./shot-temp-dir";

function busy(): Promise<void> {
  return Promise.reject(Object.assign(new Error("EBUSY: resource busy or locked, rm"), { code: "EBUSY" }));
}

const gaveUpQuickly = { remove: busy, budgetMs: 20, firstDelayMs: 1 };

test("a capture's result survives a temp folder Windows still has locked", async () => {
  const result = await withShotTempDir("gloom-shot-temp-test-", async (dir) => {
    expect(existsSync(dir)).toBe(true);
    return { rendered: dir };
  }, gaveUpQuickly);

  expect(result.rendered).toContain("gloom-shot-temp-test-");
});

test("a capture's own error is not replaced by the temp folder lock", async () => {
  await expect(withShotTempDir("gloom-shot-temp-test-", async () => {
    throw new Error("Chrome did not return screenshot data.");
  }, gaveUpQuickly)).rejects.toThrow("Chrome did not return screenshot data.");
});

test("the temp folder is removed once the capture is done", async () => {
  let folder = "";
  await withShotTempDir("gloom-shot-temp-test-", async (dir) => {
    folder = dir;
  });
  expect(folder).not.toBe("");
  expect(existsSync(folder)).toBe(false);
});
