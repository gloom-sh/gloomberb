import { resolveRenderLib } from "@opentui/core";

// Importing @opentui/core swallows a render library that fails to load and
// throws only on first use, so load it here: the glibc library on a musl
// system fails this way ("getcontext: symbol not found").
resolveRenderLib();
