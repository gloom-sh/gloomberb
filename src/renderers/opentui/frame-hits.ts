import { Renderable, RGBA, type CliRenderer } from "@opentui/core";
import type { NativeFrameHits } from "../../ui/host";

function filled(color: unknown): boolean {
  return color instanceof RGBA && color.a > 0;
}

/**
 * The terminal's hit grid as the image layer reads it: every renderable the
 * frame drew claims its cells, the one drawn last on top, so it says what
 * covers a kitty image whichever pane, menu, toast or bar drew it.
 */
export function createFrameHits(renderer: CliRenderer): NativeFrameHits {
  return {
    at(x, y) {
      if (renderer.isDestroyed) return null;
      return Renderable.renderablesByNumber.get(renderer.hitTest(x, y)) ?? null;
    },
    paints(renderable) {
      const node = renderable as { backgroundColor?: unknown; bg?: unknown };
      return filled(node.backgroundColor) || filled(node.bg);
    },
    attached(renderable) {
      let node = renderable as { parent?: unknown; isDestroyed?: boolean } | null;
      if (!node || node.isDestroyed) return false;
      for (let depth = 0; node && depth < 512; depth += 1) {
        if (node === renderer.root) return true;
        node = (node.parent ?? null) as typeof node;
      }
      return false;
    },
  };
}
