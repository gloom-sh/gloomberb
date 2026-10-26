/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FloatingPaneWrapper } from "../../../components/layout/floating-pane";
import { CaptureDatesDataContext } from "../../../components/layout/pane/capture-status";
import { PaneFooterProvider, datesPaneData, hasPaneFooterContent, type PaneFooterSegment } from "../../../components/layout/pane/footer";
import { resolvePaneBodyFrame } from "../../../components/layout/pane/sizing";

/** What a capture's status line dates (`CaptureStatusLine`): the pane's own data, the quotes on screen, or neither. */
type ShotLineDates = "data" | "quotes" | null;

declare global {
  interface Window {
    /**
     * Set by a capture that carries a status line: shows the first of the
     * variants (longest first) that fits the footer, cut in the middle when
     * none does, and resolves to the text shown. `dates` says what the line
     * dates, so the pane's own text that says the same goes.
     */
    __GLOOM_CLI_SHOT_FIT_STATUS__?: (variants: string[], options?: { dates?: ShotLineDates }) => Promise<string>;
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
 * The first variant that fits; else, when the footer can make room (the
 * pane's own `as of` gives way), the first that fits then; else the last one
 * cut in the middle as little as it must be. `show` puts a text on screen and
 * resolves once it is drawn.
 */
async function fitStatusLine(
  variants: readonly string[],
  show: (text: string) => Promise<void>,
  overflows: () => boolean,
  makeRoom: () => Promise<boolean> = async () => false,
): Promise<string> {
  const firstFit = async () => {
    for (const variant of variants) {
      await show(variant);
      if (!overflows()) return variant;
    }
    return null;
  };
  const fit = await firstFit() ?? (await makeRoom() ? await firstFit() : null);
  if (fit != null) return fit;
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

interface ShotStatusLineState {
  text: string;
  dates: ShotLineDates;
  /** No variant fit beside the pane's own `as of`, so it gave way. */
  crowded: boolean;
}

function useShotStatusLine(enabled: boolean, hasAsOf: () => boolean): ShotStatusLineState {
  const [text, setText] = useState(PENDING_STATUS);
  const [dates, setDates] = useState<ShotLineDates>(null);
  const [crowded, setCrowded] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    // What the line says goes before it is fitted, so the line gets its room.
    window.__GLOOM_CLI_SHOT_FIT_STATUS__ = (variants, options) => {
      setDates(options?.dates ?? null);
      setCrowded(false);
      const show = async (next: string) => {
        setText(next);
        await nextFrames(2);
      };
      return fitStatusLine(variants, show, footerOverflows, async () => {
        if (!hasAsOf()) return false;
        setCrowded(true);
        await nextFrames(2);
        return true;
      });
    };
    return () => {
      delete window.__GLOOM_CLI_SHOT_FIT_STATUS__;
    };
  }, [enabled, hasAsOf]);
  return { text, dates, crowded };
}

/**
 * Static captures retain warnings, what a filter leaves out (`capture`) and
 * optional source status without action shortcuts. With `statusLine` the footer also carries the capture's dated
 * status line (`Fri 9 Oct close · 15 min delayed · markets closed until Mon`),
 * inside the requested size: the body gives up the footer row for it. The
 * pane's own text that says the same goes, so the date is said once: its `as
 * of` (a footer segment or a query bar's) when the line dates the pane's data,
 * and its quote date and delay when the line states them. A pane's `as of`
 * also gives way before the line would be cut.
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
  const shownAsOf = useRef(false);
  const hasAsOf = useCallback(() => shownAsOf.current, []);
  const { text: statusText, dates, crowded } = useShotStatusLine(statusLine, hasAsOf);
  const datesData = statusLine && dates === "data";
  return <PaneFooterProvider>{(registeredFooter) => {
    const status: PaneFooterSegment[] = statusLine ? [{ id: "shot-status", parts: [{ text: statusText, tone: "label" }] }] : [];
    const info = registeredFooter.info.filter((segment) => (preserveStatus || segment.icon === "warning" || segment.capture)
      && !(datesPaneData(segment) && (datesData || crowded))
      && !(segment.quoteStatus && statusLine && dates !== null));
    shownAsOf.current = info.some(datesPaneData);
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
      <CaptureDatesDataContext.Provider value={datesData}>{children(bodyFrame)}</CaptureDatesDataContext.Provider>
    </FloatingPaneWrapper>;
  }}</PaneFooterProvider>;
}
