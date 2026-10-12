import { join } from "path";
import { SHOT_VIEW_ARCHIVE, usePrebuiltShotView } from "../../../cli/desktop-pane-shot-view";

// Bun resolves native packages beside the bundle; neither those nor the pane
// page need the launcher's cwd. Keep it for relative paths supplied by users.
usePrebuiltShotView(join(import.meta.dir, SHOT_VIEW_ARCHIVE));
await import("../../../cli/entry");
