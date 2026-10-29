import { appendFileSync } from "fs";
import { join } from "path";

// Diagnostic build only: each startup step, written at once so a crash keeps it.
const file = join(process.env.LOCALAPPDATA ?? ".", "gloom-diag-trace.log");
const started = Date.now();

export function trace(step: string): void {
  try {
    appendFileSync(file, `${new Date().toISOString()} +${Date.now() - started}ms ${step}\n`);
  } catch {
    // Diagnostics only.
  }
}

trace(`trace loaded, pid ${process.pid}, icon ${process.env.GLOOM_DIAG_NO_ICON ? "off" : "on"}, frame ${process.env.GLOOM_DIAG_NO_CHROME ? "off" : "on"}`);
// The Bun thread's heartbeat: a gap is a stretch it was blocked.
const heartbeat = setInterval(() => trace("tick"), 250);
heartbeat.unref?.();
