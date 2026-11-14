import { join } from "path";
import { testAppEnv } from "./test-app-env";

const rootDir = join(import.meta.dir, "..");
// Electrobun 2's npm package is a launcher for Hutch, which runs the build.
const electrobun = join(rootDir, "node_modules", "electrobun", "bin", "electrobun.cjs");

const proc = Bun.spawn([process.execPath, electrobun, "dev", "--watch"], {
  cwd: rootDir,
  env: testAppEnv(),
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});
const code = await proc.exited;
if (proc.signalCode) {
  console.error(`electrobun dev exited from signal ${proc.signalCode}`);
  process.exit(1);
}
process.exit(code);
