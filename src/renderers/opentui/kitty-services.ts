import { ensureKittySupport, getCachedKittySupport } from "../../components/chart/native/kitty/support";
import { getNativeSurfaceManager } from "../../components/chart/native/surface/manager";
import type { NativeRendererHost } from "../../ui/host";

/**
 * Gives a terminal renderer host the kitty graphics services that shared code
 * reaches through it. Only the terminal sets these, so the kitty modules (and
 * their Node-only imports) stay out of the desktop and web bundles.
 */
export function provideKittyServices(host: NativeRendererHost): NativeRendererHost {
  host.getKittySupport = () => getCachedKittySupport(host);
  host.ensureKittySupport = () => ensureKittySupport(host);
  host.nativeSurfaceManager = getNativeSurfaceManager(host);
  return host;
}
