import { spyOn } from "bun:test";
import { SAVED_COPY_TEST_NOW } from "./plugin-persistence";

/** Runs `run` with `Date.now` moving one millisecond on every read, so two reads made for one event never agree. */
export async function withTickingClock<T>(run: () => Promise<T>): Promise<T> {
  let now = SAVED_COPY_TEST_NOW;
  const clock = spyOn(Date, "now").mockImplementation(() => now++);
  try {
    return await run();
  } finally {
    clock.mockRestore();
  }
}
