/** @jsxImportSource react */
import { useEffect, useState, type ReactNode } from "react";
import { FloatingPaneWrapper } from "../../../components/layout/floating-pane";
import { PaneFooterProvider, hasPaneFooterContent, type PaneFooterSegment } from "../../../components/layout/pane/footer";
import { resolvePaneBodyFrame } from "../../../components/layout/pane/sizing";

declare global {
  interface Window {
    /**
     * Set by a capture that carries a status line: shows the first of the
     * variants (longest first) that fits the footer, cut in the middle when
     * none does, and resolves to the text shown.
     */
    __GLOOM_CLI_SHOT_FIT_STATUS__?: (variants: string[]) => Promise<string>;
  }
}

/**
 * Holds the footer row from the first frame, while the status line is still
 * being worked out from what the pane loaded, so the body never resizes.
 */
const PENDING_STATUS = "\u00a0";

function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(count);
  });
}

/** Keeps the start and the end of a line that does not fit, `keep` characters in all. */
function middleEllipsis(text: string, keep: number): string {
  if (keep >= text.length) return text;
  const head = Math.ceil(keep / 2);
  const tail = Math.max(0, keep - head);
  return `${text.slice(0, head).trimEnd()}…${tail > 0 ? text.slice(text.length - tail).trimStart() : ""}`;
}

/**
 * The first variant that fits, else the last one cut in the middle as little
 * as it must be. `show` puts a text on screen and resolves once it is drawn.
 */
async function fitStatusLine(
  variants: readonly string[],
  show: (text: string) => Promise<void>,
  overflows: () => boolean,
): Promise<string> {
  for (const variant of variants) {
    await show(variant);
    if (!overflows()) return variant;
  }
  const last = variants.at(-1) ?? "";
  let low = 1;
  let high = last.length - 1;
  let best = middleEllipsis(last, 1);
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const text = middleEllipsis(last, keep);
    await show(text);
    if (overflows()) {
      high = keep - 1;
    } else {
      best = text;
      low = keep + 1;
    }
  }
  await show(best);
  return best;
}

function footerOverflows(): boolean {
  const footer = document.querySelector('[data-gloom-role="pane-footer"]');
  if (!footer) return false;
  return [footer, ...footer.querySelectorAll("*")].some((element) => (
    element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1
  ));
}

function useShotStatusLine(enabled: boolean): string {
  const [text, setText] = useState(PENDING_STATUS);
  useEffect(() => {
    if (!enabled) return;
    window.__GLOOM_CLI_SHOT_FIT_STATUS__ = (variants) => fitStatusLine(variants, async (next) => {
      setText(next);
      await nextFrames(2);
    }, footerOverflows);
    return () => {
      delete window.__GLOOM_CLI_SHOT_FIT_STATUS__;
    };
  }, [enabled]);
  return text;
}

/**
 * Static captures retain warnings and optional source status without action
 * shortcuts. With `statusLine` the footer also carries the capture's dated
 * status line (`Fri 9 Oct close · 15 min delayed · markets closed until Mon`),
 * inside the requested size: the body gives up the footer row for it.
 */
export function PaneShotFrame({ paneId, title, width, height, preserveStatus = false, statusLine = false, children }: {
  paneId: string;
  title: string;
  width: number;
  height: number;
  preserveStatus?: boolean;
  statusLine?: boolean;
  children: (frame: ReturnType<typeof resolvePaneBodyFrame>) => ReactNode;
}) {
  const statusText = useShotStatusLine(statusLine);
  return <PaneFooterProvider>{(registeredFooter) => {
    const status: PaneFooterSegment[] = statusLine ? [{ id: "shot-status", parts: [{ text: statusText, tone: "label" }] }] : [];
    const info = registeredFooter.info.filter((segment) => preserveStatus || segment.icon === "warning");
    const footer = { info: [...info, ...status], hints: [], menu: [], keys: [] };
    const bodyFrame = resolvePaneBodyFrame({
      width,
      height,
      nativePaneChrome: true,
      footerVisible: hasPaneFooterContent(footer),
      reserveFooter: false,
    });
    return <FloatingPaneWrapper
      paneId={paneId}
      title={title}
      x={0}
      y={0}
      width={width}
      height={height}
      zIndex={1}
      focused
      showActions={false}
      footer={footer}
    >
      {children(bodyFrame)}
    </FloatingPaneWrapper>;
  }}</PaneFooterProvider>;
}
