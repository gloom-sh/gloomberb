import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { testAppEnv } from "./test-app-env";

if (process.platform === "win32") throw new Error("The DES smoke check needs POSIX process groups for browser cleanup.");

const root = join(homedir(), ".cache", "gloom-smoke");
await mkdir(root, { recursive: true });
const profile = await mkdtemp(join(root, "des-render-"));
try {
  const env = testAppEnv({
    GLOOMBERB_API_URL: "http://127.0.0.1:1",
    GLOOMBERB_HOME: profile,
    GLOOMBERB_SESSION_TOKEN: "",
    GLOOM_TEST_DES_RENDER: "1",
    TMPDIR: profile,
  });
  const worker = Bun.spawn([
    process.execPath, "--no-env-file", "test", "src/cli/bare-listing-abroad.test.ts",
    "--test-name-pattern", "^renders DES in Chrome with fixture data$",
  ], { env, detached: true, stdout: "inherit", stderr: "inherit" });
  const aborted = Promise.withResolvers<never>();
  const deadline = setTimeout(() => aborted.reject(new Error("DES render smoke check exceeded its 75-second deadline.")), 75_000);
  const interrupt = () => aborted.reject(new Error("DES render smoke check interrupted."));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    process.exitCode = await Promise.race([worker.exited, aborted.promise]);
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (worker.exitCode !== 0) {
      try {
        process.kill(-worker.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      } finally {
        await worker.exited;
      }
    }
  }
} finally {
  await rm(profile, { recursive: true, force: true });
}
