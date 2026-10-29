// Runs first in Electrobun's launcher script (Resources/main.js) on Windows,
// before it starts the app's worker and the browser engine. The Windows build
// step puts it there (scripts/install-electrobun-tui-shim.ts).
import { leaveEmulationFaultsToWindows } from "./windows-emulation";

if (process.platform === "win32") {
  try {
    const result = leaveEmulationFaultsToWindows();
    if (result !== "not emulated") console.log(`[launcher] x64 emulation: ${result}`);
  } catch (error) {
    console.error("[launcher] could not check for x64 emulation", error);
  }
}
