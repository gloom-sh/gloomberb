import { useEffect, useLayoutEffect, useState } from "react";
import { Badge, type BadgeProps } from "../../src/components/ui/display";
import { useThemeColors } from "../../src/theme/theme-context";
import { Box } from "../../src/ui";

/**
 * The chips badge-ink.ts measures (`scenario=badge-ink`): the status bar's
 * mail chip with lowercase names, a descender and a count, and plain chips
 * in lowercase, capitals and digits, one per row as a status bar or table
 * row holds them. When they have drawn, the page publishes where each chip,
 * its icon and every character of its label sit (`window.__badgeInk`), for
 * the measure to find their ink in a picture.
 */

export const BADGE_INK_SPECIMENS: (BadgeProps & { id: string })[] = [
  { id: "mail alex", label: "alex", icon: "mail", tone: "warning", translate: false },
  { id: "mail sam +2", label: "sam +2", icon: "mail", tone: "warning", translate: false },
  { id: "mail jpeg", label: "jpeg", icon: "mail", tone: "warning", translate: false },
  { id: "mail alex +1", label: "alex +1", icon: "mail", tone: "warning", translate: false },
  { id: "mail only", label: "", icon: "mail", tone: "warning" },
  { id: "plain @ sam", label: "@ sam", tone: "warning", translate: false },
  { id: "plain alex", label: "alex", tone: "warning", translate: false },
  { id: "plain jpeg", label: "jpeg", translate: false },
  { id: "plain SXM", label: "SXM" },
  { id: "plain 80GB", label: "80GB" },
  { id: "plain 13F", label: "13F", tone: "accent" },
  { id: "plain LIVE", label: "LIVE", tone: "negative", variant: "solid" },
];

interface Rect { x: number; y: number; width: number; height: number }

export interface BadgeInkLayout {
  ready: true;
  /** CSS pixels; a picture of the page is this many times wider. */
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  fontFamily: string;
  fontSize: string;
  specimens: {
    id: string;
    chip: Rect;
    icon: Rect | null;
    /** The label's characters, each with the box the font advances it by. */
    chars: { char: string; box: Rect }[];
  }[];
}

declare global {
  interface Window { __badgeInk?: BadgeInkLayout }
}

function rectOf(rect: DOMRect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function layout(): BadgeInkLayout {
  const specimens = BADGE_INK_SPECIMENS.map(({ id }) => {
    const chip = document.querySelector(`[data-badge-ink="${CSS.escape(id)}"] [data-gloom-ui="badge"]`)!;
    const icon = chip.querySelector("svg");
    const chars: { char: string; box: Rect }[] = [];
    const walker = document.createTreeWalker(chip, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (let index = 0; index < text.length; index += 1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        chars.push({ char: text[index]!, box: rectOf(range.getBoundingClientRect()) });
      }
    }
    return { id, chip: rectOf(chip.getBoundingClientRect()), icon: icon ? rectOf(icon.getBoundingClientRect()) : null, chars };
  });
  const label = document.querySelector('[data-gloom-ui="badge"] span') ?? document.body;
  const style = getComputedStyle(label);
  return { ready: true, viewport: { width: window.innerWidth, height: window.innerHeight }, devicePixelRatio: window.devicePixelRatio, fontFamily: style.fontFamily, fontSize: style.fontSize, specimens };
}

export function BadgeInkFixture() {
  const colors = useThemeColors();
  // `&font=` resizes the grid cell after the first render and says so with a resize: draw again at the new size.
  const [, redraw] = useState(0);
  useLayoutEffect(() => {
    const onResize = () => redraw((count) => count + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    // Once the fonts have loaded, the chips have their final glyphs. A timer, not a frame: an
    // off-screen system WebView (wkwebview-snapshot.swift) draws no animation frames.
    void document.fonts.ready.then(() => setTimeout(() => { window.__badgeInk = layout(); }, 100));
  }, []);
  return (
    <Box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg} style={{ padding: 16, gap: 8 }}>
      {BADGE_INK_SPECIMENS.map(({ id, ...badge }) => (
        <Box key={id} data-badge-ink={id} flexDirection="row" height={1}><Badge {...badge} /></Box>
      ))}
    </Box>
  );
}
