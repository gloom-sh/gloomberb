/** A scrolling box as the page measures it. */
export interface ScrollBoxMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  /** The box draws a scrollbar on that axis, which says it overflows even when the measures cannot. */
  scrollbarY: boolean;
  scrollbarX: boolean;
}

/**
 * What a capture leaves out of a scrolling box, naming the side: a chain
 * centred on the money is cut above and below, a list at its top only below.
 * Self-contained so the screenshot runner can evaluate it in the browser.
 */
export function scrollTruncationReasons(box: ScrollBoxMetrics): string[] {
  const reasons: string[] = [];
  const cut = (offset: number, content: number, viewport: number, flagged: boolean, noun: string, sides: readonly [string, string, string, string]) => {
    if (!flagged && !(content > viewport + 1)) return;
    // One pixel either way is subpixel layout, not a hidden row.
    const before = offset > 1;
    const after = offset + viewport < content - 1;
    // A drawn scrollbar over content that measures as fitting (a list that loads more) cannot say which side.
    reasons.push(before || after
      ? `${noun} ${before && after ? sides[2] : before ? sides[0] : sides[1]} the rendered viewport are cut`
      : `${noun} ${sides[3]} the rendered viewport may be cut`);
  };
  cut(box.scrollTop, box.scrollHeight, box.clientHeight, box.scrollbarY, "rows", ["above", "below", "above and below", "above or below"]);
  cut(box.scrollLeft, box.scrollWidth, box.clientWidth, box.scrollbarX, "columns", ["left of", "right of", "left and right of", "left or right of"]);
  return reasons;
}
