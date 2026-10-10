/**
 * Which axes a ScrollBox scrolls on, decided from its props. The terminal and
 * DOM hosts and the pane keyboard scroll registration all read it here, so a
 * ScrollBox that omits `scrollY` behaves the same everywhere: it scrolls
 * vertically, with the wheel and with the arrows, PageUp, PageDown, Home and
 * End. Pass `scrollY={false}` to turn that off.
 */
interface ScrollBoxAxisProps {
  scrollX?: unknown;
  scrollY?: unknown;
  height?: unknown;
}

/**
 * A one-row strip that only scrolls sideways: tab bars, table headers and
 * chart legends. It is not a vertical scroller even though `scrollY` is
 * omitted.
 */
export function isHeaderStripScrollBox(props: ScrollBoxAxisProps): boolean {
  return props.scrollX === true && props.scrollY !== true && props.height === 1;
}

/** Whether the ScrollBox scrolls vertically: unless `scrollY` is false, and never a header strip. */
export function scrollBoxScrollsVertically(props: ScrollBoxAxisProps): boolean {
  return props.scrollY !== false && !isHeaderStripScrollBox(props);
}
