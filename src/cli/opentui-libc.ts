import { detectLinuxLibc, selectOpenTuiLibc } from "../utils/linux-libc";

// Imported before anything else by every entry: @opentui/core picks its
// native library the moment it loads.
selectOpenTuiLibc(process.env, detectLinuxLibc());
