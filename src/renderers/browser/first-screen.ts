/**
 * The web terminal's first screen for a new visitor: the `web_first_screen`
 * experiment. The control is today's six-pane workspace; `calm` opens two of
 * the same panes (config-host.ts). Nothing else differs between the arms.
 *
 * The arm is asked for once, when the first layout is chosen, before the dock
 * first paints, and that request is the exposure (`exposeWebExperiment`, see
 * web-experiments.ts for who is never asked). A browser with a saved workspace
 * keeps it and is not asked, so a returning visitor is never moved between
 * layouts or counted again. A link that hands over a shared pane or layout
 * lands on what was shared, so it keeps today's screen and is not asked
 * either. When the API answers late the visitor gets the control and the
 * request is dropped.
 *
 * The measure is the visitor's first action in that first browser session:
 * opening a function, changing the ticker, or typing in the command bar. It
 * goes out once as `first_screen_engaged`, with only the placement; never the
 * function, the ticker or the text.
 */
import type { StorageLike } from "../../api-client/web-experiments";
import type { LayoutConfig } from "../../types/config";
import type { DesktopDeepLinkBridge } from "../../types/desktop-deeplink";
import { settleWithin } from "../../utils/async-deadline";
import type { BrowserFirstScreen } from "./config-host";

export const FIRST_SCREEN_EXPERIMENT = "web_first_screen";
/** The exposure's and the engagement's placement. */
export const FIRST_SCREEN_PLACEMENT = "first-screen";
/** How long the first paint waits for the arm before showing the control. */
const FIRST_SCREEN_DEADLINE_MS = 1_500;
const ENGAGEMENT_SESSION_KEY = "gloomberb.web.first-screen";
const WATCHING = "watching";
const ENGAGED = "engaged";

export interface FirstScreenVisit {
  /** A workspace saved on an earlier visit. */
  savedLayout: boolean;
  /** The address hands over a shared pane or layout to open. */
  handoff: boolean;
  /**
   * Asks for the arm and counts the exposure; null when the visitor is not in
   * the experiment. The signal fires at the deadline.
   */
  expose(signal: AbortSignal): Promise<string | null>;
  deadlineMs?: number;
}

/**
 * The first screen this visit was counted in, or null when it was not counted:
 * the visitor sees what they would have without the experiment (a saved
 * workspace, or today's first screen).
 */
export async function exposeFirstScreen(visit: FirstScreenVisit): Promise<BrowserFirstScreen | null> {
  if (visit.savedLayout || visit.handoff) return null;
  const deadlineMs = visit.deadlineMs ?? FIRST_SCREEN_DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    let request: Promise<string | null>;
    try {
      request = visit.expose(controller.signal);
    } catch {
      return null;
    }
    const variant = await settleWithin(request, deadlineMs);
    if (variant === "calm") return "calm";
    return variant === null ? null : "control";
  } finally {
    clearTimeout(timer);
  }
}

function read(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: StorageLike, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    /* Without session storage only this page load is watched. */
  }
}

/** The ticker without its venue, so a link's listing settling (7203:TSE to 7203:JPX) is not a change. */
function baseSymbol(symbol: string): string {
  return symbol.split(":")[0]!.trim().toUpperCase();
}

interface FirstScreenSources {
  subscribeFunctionOpens(listener: () => void): () => void;
  subscribeCommandBarQuery(listener: (query: string) => void): () => void;
}

interface Watcher {
  engage(): void;
  /** Tickers on screen so far in this page load; a new one is a change. */
  seen: Set<string>;
  /** Set while the app handles the address it was opened with. */
  handlingLink: boolean;
}

let watcher: Watcher | null = null;

/**
 * Watches this browser session for the visitor's first action once the first
 * screen was counted, and resumes after a reload in the same session. Sends
 * `record` at most once; a later session is never watched.
 */
export function watchFirstScreenEngagement({
  counted,
  session,
  layout,
  record,
  sources,
}: {
  /** This page load was counted in the experiment. */
  counted: boolean;
  session: StorageLike;
  /** The workspace it opens on; its tickers are not a change. */
  layout: LayoutConfig;
  record: () => void;
  sources: FirstScreenSources;
}): () => void {
  if (counted) write(session, ENGAGEMENT_SESSION_KEY, WATCHING);
  if (read(session, ENGAGEMENT_SESSION_KEY) !== WATCHING) return () => {};

  const unsubscribes: Array<() => void> = [];
  const stop = () => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    if (watcher === current) watcher = null;
  };
  const current: Watcher = {
    seen: new Set(layout.instances.flatMap((instance) => (
      instance.binding?.kind === "fixed" ? [baseSymbol(instance.binding.symbol)] : []
    ))),
    handlingLink: false,
    engage() {
      if (current.handlingLink || read(session, ENGAGEMENT_SESSION_KEY) !== WATCHING) return;
      write(session, ENGAGEMENT_SESSION_KEY, ENGAGED);
      stop();
      record();
    },
  };
  watcher = current;
  unsubscribes.push(
    sources.subscribeFunctionOpens(() => current.engage()),
    sources.subscribeCommandBarQuery((query) => {
      if (query.trim()) current.engage();
    }),
  );
  return stop;
}

/**
 * The focused pane's ticker changed (the app's `ticker:selected`). Moving focus
 * between panes that show tickers already on screen is not a change; a ticker
 * that was not on screen yet is.
 */
export function noteFirstScreenTicker(symbol: string | null, previous: string | null): void {
  const current = watcher;
  if (!current) return;
  if (previous) current.seen.add(baseSymbol(previous));
  if (!symbol) return;
  const next = baseSymbol(symbol);
  if (current.seen.has(next)) return;
  current.seen.add(next);
  current.engage();
}

/**
 * The address the terminal was opened with (a research link) opens its pane as
 * if asked; that is the landing, not the visitor's first action.
 */
export function observeLandingLinks(bridge: DesktopDeepLinkBridge): DesktopDeepLinkBridge {
  return {
    subscribe(listener) {
      return bridge.subscribe((link) => {
        const current = watcher;
        if (current) current.handlingLink = true;
        try {
          listener(link);
        } finally {
          if (current) current.handlingLink = false;
        }
      });
    },
  };
}
