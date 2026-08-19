import { type NativeRendererHost as CliRenderer } from "../../../../ui";
import { writeRendererRaw } from "./adapter";
import { buildKittyGraphicsQuery } from "./protocol";

export interface RendererCapabilities {
  kitty_graphics?: boolean;
  multiplexer?: string;
}

interface SupportCacheEntry {
  value: boolean | null;
  promise?: Promise<boolean>;
}

const supportCache = new WeakMap<CliRenderer, SupportCacheEntry>();
const QUERY_TIMEOUT_MS = 250;

/**
 * A multiplexer swallows the graphics query and then passes image payloads
 * through as literal text, which shreds the screen. Whatever it advertises,
 * kitty graphics are not usable behind one.
 */
export function isMultiplexedTerminal(
  capabilities: RendererCapabilities | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const reported = capabilities?.multiplexer;
  // The renderer's own detection wins when it has one; the environment is only
  // consulted when nothing was reported.
  if (typeof reported === "string") return reported !== "none";
  if (env.TMUX) return true;
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (termProgram === "tmux" || termProgram === "screen") return true;
  const term = (env.TERM ?? "").toLowerCase();
  return term.startsWith("tmux") || term.startsWith("screen");
}

/**
 * What is known about kitty graphics before querying: `null` means undecided,
 * so the query result (or its absence) decides.
 */
export function resolveKittySupport(
  capabilities: RendererCapabilities | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean | null {
  if (isMultiplexedTerminal(capabilities, env)) return false;
  return typeof capabilities?.kitty_graphics === "boolean" ? capabilities.kitty_graphics : null;
}

function readKnownSupport(renderer: CliRenderer): boolean | null {
  return resolveKittySupport(renderer.capabilities as RendererCapabilities | null);
}

export function getCachedKittySupport(renderer: CliRenderer): boolean | null {
  const known = readKnownSupport(renderer);
  if (known !== null) return known;
  return supportCache.get(renderer)?.value ?? null;
}

export function ensureKittySupport(renderer: CliRenderer): Promise<boolean> {
  const known = readKnownSupport(renderer);
  if (known !== null) {
    supportCache.set(renderer, { value: known });
    return Promise.resolve(known);
  }

  const cached = supportCache.get(renderer);
  if (cached?.promise) return cached.promise;

  const nextEntry: SupportCacheEntry = { value: null };
  const promise = new Promise<boolean>((resolve) => {
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      renderer.off("capabilities", onCapabilities);
      nextEntry.value = value;
      nextEntry.promise = undefined;
      resolve(value);
    };

    const onCapabilities = () => {
      const supported = readKnownSupport(renderer);
      if (supported !== null) finish(supported);
    };

    // No answer means unsupported: a terminal that speaks the protocol answers,
    // and anything that swallows the query would also swallow the image.
    const timer = setTimeout(() => finish(false), QUERY_TIMEOUT_MS);
    renderer.on("capabilities", onCapabilities);
    if (!writeRendererRaw(renderer, `${buildKittyGraphicsQuery()}\x1b[c`)) {
      finish(false);
      return;
    }
    const supported = readKnownSupport(renderer);
    if (supported !== null) finish(supported);
  });

  nextEntry.promise = promise;
  supportCache.set(renderer, nextEntry);
  return promise;
}
