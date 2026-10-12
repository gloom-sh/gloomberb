import { join } from "path";
import { SHOT_VIEW_ARCHIVE, usePrebuiltShotView } from "../../../cli/desktop-pane-shot-view";

// Start Bun in the app folder so it cannot load a caller's .env or bunfig
// preload. Restore cwd only after startup, before importing the CLI graph.
const callerCwd = process.env.GLOOMBERB_CALLER_CWD;
delete process.env.GLOOMBERB_CALLER_CWD;
if (callerCwd !== undefined) {
  try {
    process.chdir(callerCwd);
  } catch {
    console.error("error: Could not open the caller's working directory.");
    process.exit(1);
  }
}

usePrebuiltShotView(join(import.meta.dir, SHOT_VIEW_ARCHIVE));
await import("../../../cli/entry");
