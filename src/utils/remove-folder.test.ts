import { expect, test } from "bun:test";
import { removeFolder } from "./remove-folder";

function busy(): Promise<void> {
  return Promise.reject(Object.assign(new Error("EBUSY: resource busy or locked, rm"), { code: "EBUSY" }));
}

// Bun's own rm takes maxRetries and retryDelay and ignores them, so the first
// EBUSY from a folder a closing browser still holds would end the removal.
test("a folder locked for a moment is removed once the lock clears", async () => {
  let attempts = 0;
  const lockedTwice = (): Promise<void> => (++attempts <= 2 ? busy() : Promise.resolve());

  expect(await removeFolder("locked", { remove: lockedTwice, firstDelayMs: 1 })).toBeNull();
  expect(attempts).toBe(3);
});

test("a folder that stays locked is given up on with its error, not thrown", async () => {
  let attempts = 0;
  const error = await removeFolder("locked", {
    remove: () => { attempts += 1; return busy(); },
    budgetMs: 60,
    firstDelayMs: 1,
  });

  expect((error as NodeJS.ErrnoException).code).toBe("EBUSY");
  expect(attempts).toBeGreaterThan(1);
});
