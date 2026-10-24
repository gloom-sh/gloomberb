import { resolveRenderLib } from "@opentui/core";
import { loadRenderLib } from "./render-lib";

// Loaded the way a launch loads it, so the smoke covers the cache folder used
// when the temp folder cannot run the library.
await loadRenderLib();
// Importing @opentui/core swallows a render library that fails to load and
// throws only on first use, so load it here: the glibc library on a musl
// system fails this way ("getcontext: symbol not found").
resolveRenderLib();
