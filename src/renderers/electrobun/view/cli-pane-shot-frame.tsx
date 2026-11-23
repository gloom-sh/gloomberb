/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FloatingPaneWrapper } from "../../../components/layout/floating-pane";
import { CaptureDatesDataContext, PaneCaptureContext } from "../../../components/layout/pane/capture-status";
import { PaneFooterProvider, datesPaneData, hasPaneFooterContent, type PaneFooterSegment } from "../../../components/layout/pane/footer";
import { noteLineParts } from "../../../components/layout/pane/footer/model";
import { resolvePaneBodyFrame } from "../../../components/layout/pane/sizing";
import { Prose } from "../../../components/ui/prose";
import { useThemeColors } from "../../../theme/theme-context";

/** What a capture's status line dates (`CaptureStatusLine`): the pane's own data, the quotes on screen, or neither. */
type ShotLineDates = "data" | "quotes" | null;

declare global {
  interface Window {
    /**
     * Set by a capture that carries a status line: shows the first of the
     * variants (longest first) that fits the footer, cut in the middle when
     * none does, and resolves to the text shown. `dates` says what the line
     * dates, so the pane's own text that says the same goes. `ownStatus`: the
     * view dates its data in its own footer (a DES research tab), which stays
     * whole beside the line. With no variants the pane has nothing to date:
     * the footer row is given back to the body and the text shown is empty.
     */
    __GLOOM_CLI_SHOT_FIT_STATUS__?: (variants: string[], options?: { dates?: ShotLineDates; ownStatus?: boolean }) => Promise<string>;
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

/** What a cut line's ends do not start or end on beside the ellipsis: a separator or a space. */
const LOOSE_END = /^[\s·,;:]+|[\s·,;:]+$/gu;

/**
 * Keeps the start and the end of a line that does not fit, `keep` characters
 * in all, in whole words ("US trading day Mon … 15 min delayed"), never a
 * word cut ("Mon 1…ose"); by characters only where not a word fits either end.
 */
export function middleEllipsis(text: string, keep: number): string {
  if (keep >= text.length) return text;
  const headRoom = Math.ceil(keep / 2);
  const tailRoom = Math.max(0, keep - headRoom);
  const words = text.split(" ");
  let head = "";
  for (const word of words) {
    const next = head ? `${head} ${word}` : word;
    if (next.length > headRoom) break;
    head = next;
  }
  let tail = "";
  for (const word of [...words].reverse()) {
    const next = tail ? `${word} ${tail}` : word;
    if (next.length > tailRoom) break;
    tail = next;
  }
  head = head.replace(LOOSE_END, "");
  tail = tail.replace(LOOSE_END, "");
  if (head && tail) return `${head} … ${tail}`;
  if (head) return `${head}…`;
  return `${text.slice(0, headRoom).trimEnd()}…${tailRoom > 0 ? text.slice(text.length - tailRoom).trimStart() : ""}`;
}

/**
 * The first variant that fits; else, when the footer can make room (the
 * pane's own `as of` gives way), the first that fits then; else the last one
 * cut in the middle, between words, as little as it must be. A note line
 * keeps its share of the row (fitPaneFooterInfo): its first words say more
 * than the rest of a status line. `show` puts a text on screen and resolves
 * once it is drawn.
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
  /** Null once the capture has no line to show: the footer row is gone. */
  text: string | null;
  dates: ShotLineDates;
  /** No variant fit beside the pane's own `as of`, so it gave way. */
  crowded: boolean;
  /** The view dates its data in its own footer, which the capture keeps. */
  ownStatus: boolean;
}

function useShotStatusLine(enabled: boolean, hasAsOf: () => boolean): ShotStatusLineState {
  const [text, setText] = useState<string | null>(PENDING_STATUS);
  const [dates, setDates] = useState<ShotLineDates>(null);
  const [crowded, setCrowded] = useState(false);
  const [ownStatus, setOwnStatus] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    // What the line says goes before it is fitted, so the line gets its room.
    window.__GLOOM_CLI_SHOT_FIT_STATUS__ = async (variants, options) => {
      setDates(options?.dates ?? null);
      setOwnStatus(options?.ownStatus === true);
      setCrowded(false);
      if (variants.length === 0) {
        setText(null);
        await nextFrames(2);
        return "";
      }
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
  return { text, dates, crowded, ownStatus };
}

/**
 * Static captures retain the first warning in full and say how many more there
 * are. The warning wraps independently of the status line. Captures also retain what a filter leaves out (`capture`) and
 * optional source status without action shortcuts. With `statusLine` the footer also carries the capture's dated
 * status line (`Fri 9 Oct close · 15 min delayed · markets closed · regular session opens Mon 13:30 UTC, 09:30 ET`),
 * inside the requested size: the body gives up the footer row for it. The
 * pane's own text that says the same goes, so the date is said once: its `as
 * of` (a footer segment or a query bar's) when the line dates the pane's data,
 * and its quote date and delay when the line states them. A pane's `as of`
 * also gives way before the line would be cut. A view that dates its data in
 * its own footer (the line's `ownStatus`) keeps that footer's status, as
 * `preserveStatus` does for a whole pane.
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
  const { text: statusText, dates, crowded, ownStatus } = useShotStatusLine(statusLine, hasAsOf);
  const datesData = statusLine && dates === "data";
  const palette = useThemeColors();
  const [noteHeight, setNoteHeight] = useState(0);
  const noteObserver = useRef<ResizeObserver | null>(null);
  const measureNotes = useCallback((element: HTMLDivElement | null) => {
    noteObserver.current?.disconnect();
    noteObserver.current = null;
    const measure = () => setNoteHeight(element?.getBoundingClientRect().height ?? 0);
    measure();
    if (!element || typeof ResizeObserver === "undefined") return;
    noteObserver.current = new ResizeObserver(measure);
    noteObserver.current.observe(element);
  }, []);
  return <PaneFooterProvider>{(registeredFooter) => {
    const status: PaneFooterSegment[] = statusLine && statusText !== null ? [{ id: "shot-status", parts: [{ text: statusText, tone: "label" }] }] : [];
    const warnings = registeredFooter.info.filter((segment) => segment.icon === "warning" && segment.notes?.length !== 0);
    const info = registeredFooter.info.filter((segment) => segment.icon !== "warning"
      && (preserveStatus || ownStatus || segment.capture)
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
      chromeSupplementPx: warnings.length ? noteHeight : 0,
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
      footerSupplement={warnings.length > 0 ? <div ref={measureNotes} style={{ flexShrink: 0, padding: "var(--gloom-space-xs) var(--gloom-space-sm)" }}>
        {warnings.map((segment) => {
          const notes = segment.notes ?? [segment.label ?? segment.title ?? segment.parts.map((part) => part.text).join(" ")];
          const text = noteLineParts(notes, Number.POSITIVE_INFINITY).map((part) => part.text).join(" ");
          return <div key={segment.id} data-gloom-role="pane-footer-notes">
            <Prose text={text} width={width} color={palette.warning} figures={false} />
          </div>;
        })}
      </div> : null}
    >
      <PaneCaptureContext.Provider value>
        <CaptureDatesDataContext.Provider value={datesData}>{children(bodyFrame)}</CaptureDatesDataContext.Provider>
      </PaneCaptureContext.Provider>
    </FloatingPaneWrapper>;
  }}</PaneFooterProvider>;
}
