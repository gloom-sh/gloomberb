import type { GloomPluginContext } from "../../../types/plugin";
import {
  getCalendarCache,
  landedHighImpactPrints,
  loadCalendar,
  pendingHighImpactPrints,
  PRINT_PENDING_MS,
  subscribeCalendar,
  type EconCalendarCacheEntry,
} from "./calendar-model";
import type { EconEvent } from "./types";

/** The ECO setting that turns the print toast on. Off until the user turns it on, as breaking news is. */
export const ECON_PRINT_NOTIFICATIONS_ENABLED_KEY = "econPrintNotificationsEnabled";

const TOAST_DURATION_MS = 20_000;
/**
 * The waits between asks while a print is due: short just after the release
 * time, when most prints land, then longer until the window closes, which
 * keeps a release to about twenty asks per app instead of eighty.
 */
const PRINT_BACKOFF_MS = [15_000, 30_000, 60_000] as const;
/** Each wait moves by up to a fifth either way, so apps that started together drift apart. */
const PRINT_JITTER = 0.2;
/** How often the watch looks at the calendar it already has while nothing is due. */
const PRINT_IDLE_MS = 60_000;
/** While idle, a calendar this old is asked for again, so a release added since is known. */
const CALENDAR_RECHECK_MS = 6 * 60 * 60 * 1000;
/** With no calendar at all, how long a failed ask waits before the next. */
const NO_CALENDAR_RETRY_MS = 5 * 60 * 1000;

type CalendarRead = Pick<EconCalendarCacheEntry, "data" | "fetchedAt">;

export interface PrintWatchDeps {
  now: () => number;
  /** Asks for the calendar; `force` skips a fresh cache. */
  load: (force: boolean) => Promise<CalendarRead>;
  /** The cached calendar, however old, without a request. */
  read: () => CalendarRead | null;
  /** Called whenever anyone, a pane included, loads the calendar. */
  subscribe: (listener: () => void) => () => void;
  schedule: (run: () => Promise<void> | void, delay: number) => () => void;
  random: () => number;
}

const DEFAULT_DEPS: PrintWatchDeps = {
  now: Date.now,
  load: (force) => loadCalendar(force),
  read: () => getCalendarCache({ allowExpired: true }),
  subscribe: subscribeCalendar,
  schedule: (run, delay) => {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  },
  random: Math.random,
};

function printBody(event: EconEvent): string {
  return event.forecast ? `${event.event} ${event.actual} vs ${event.forecast}` : `${event.event} ${event.actual}`;
}

type PrintWatchContext = Pick<GloomPluginContext, "notify" | "showPane">;

/**
 * Toasts a high-impact print once, when it lands within
 * {@link PRINT_PENDING_MS} of its release time. While one is due the
 * calendar is asked for on {@link PRINT_BACKOFF_MS}, and every read is
 * compared: the watch's own, its idle look at the cache, and a pane's
 * refresh. The first read only records what has already printed.
 */
export function startHighImpactPrintWatch(
  ctx: PrintWatchContext,
  overrides: Partial<PrintWatchDeps> = {},
): () => void {
  const deps: PrintWatchDeps = { ...DEFAULT_DEPS, ...overrides };
  let stopped = false;
  let running = false;
  let cancel: (() => void) | null = null;
  /** The newest calendar the watch has seen. */
  let latest: CalendarRead | null = null;
  let lastAskAt = Number.NEGATIVE_INFINITY;
  let primed = false;
  /**
   * Each high-impact row not yet past its window, by id: null while blank,
   * then its number. A number stays once seen, so a print that blanks and
   * comes back is not a new print.
   */
  const actuals = new Map<string, string | null>();
  const expiries = new Map<string, number>();
  let attempt = 0;
  let dueIds = new Set<string>();

  const toast = (event: EconEvent) => {
    ctx.notify({
      title: event.country,
      body: printBody(event),
      type: "info",
      desktop: "always",
      sound: "Glass",
      duration: TOAST_DURATION_MS,
      refId: `econ:${event.id}`,
      action: { label: "Open", onClick: () => ctx.showPane("econ-calendar") },
    });
  };

  /** `now` is when the read was asked for, so a print the last ask in the window brings back still counts. */
  const observe = (read: CalendarRead | null, now = deps.now()) => {
    if (stopped || !read) return;
    if (!latest || read.fetchedAt >= latest.fetchedAt) latest = read;
    const landed = primed ? landedHighImpactPrints(actuals, read.data) : [];
    for (const event of read.data) {
      if (event.impact !== "high") continue;
      const expiresAt = event.date.getTime() + PRINT_PENDING_MS;
      if (expiresAt < now) continue;
      expiries.set(event.id, expiresAt);
      if (event.actual) actuals.set(event.id, event.actual);
      else if (!actuals.has(event.id)) actuals.set(event.id, null);
    }
    for (const [id, expiresAt] of expiries) {
      if (expiresAt >= now) continue;
      expiries.delete(id);
      actuals.delete(id);
    }
    primed = true;
    // A print that turns up after its window is recorded, not announced late.
    for (const event of landed) {
      if (now - event.date.getTime() <= PRINT_PENDING_MS) toast(event);
    }
  };

  /** Whether a print in the newest calendar is due and still within its window. */
  const printDue = (now: number): boolean => {
    const pending = latest ? pendingHighImpactPrints(latest.data, now) : [];
    // A release that has just come due starts the waits over.
    if (pending.length === 0 || pending.some((event) => !dueIds.has(event.id))) attempt = 0;
    dueIds = new Set(pending.map((event) => event.id));
    return pending.length > 0;
  };

  const backoff = (): number => {
    const base = PRINT_BACKOFF_MS[Math.min(attempt, PRINT_BACKOFF_MS.length - 1)]!;
    attempt += 1;
    return Math.round(base * (1 + (deps.random() * 2 - 1) * PRINT_JITTER));
  };

  const askWhileIdle = (now: number): boolean => (latest
    ? now - Math.max(latest.fetchedAt, lastAskAt) >= CALENDAR_RECHECK_MS
    : now - lastAskAt >= NO_CALENDAR_RETRY_MS);

  const arm = (delay: number) => {
    if (stopped || cancel) return;
    cancel = deps.schedule(() => {
      cancel = null;
      return run();
    }, delay);
  };

  const run = async () => {
    if (stopped || running) return;
    observe(deps.read());
    const before = deps.now();
    const due = printDue(before);
    if (!due && !askWhileIdle(before)) {
      arm(PRINT_IDLE_MS);
      return;
    }
    running = true;
    lastAskAt = before;
    try {
      // A due print is asked for past the cache; otherwise a fresh cache answers without a request.
      observe(await deps.load(due), before);
    } catch {
      // The next ask follows the same schedule.
    } finally {
      running = false;
    }
    if (stopped) return;
    // Past the window nothing is due, so the asks stop and the watch goes back to idle looks.
    arm(printDue(deps.now()) ? backoff() : PRINT_IDLE_MS);
  };

  // A load the watch is waiting on is compared when it answers, at the time it was asked.
  const unsubscribe = deps.subscribe(() => {
    if (!running) observe(deps.read());
  });
  void run();
  return () => {
    stopped = true;
    unsubscribe();
    cancel?.();
    cancel = null;
  };
}

type PrintNotificationContext = PrintWatchContext & Pick<GloomPluginContext, "configState" | "on">;

function printNotificationsEnabled(ctx: Pick<GloomPluginContext, "configState">): boolean {
  return ctx.configState.get<boolean>(ECON_PRINT_NOTIFICATIONS_ENABLED_KEY) === true;
}

/**
 * The one print watch, run while anything wants it: the Notifications
 * setting, or an ECO pane in view, which fills a print in as it lands. Every
 * reason shares its timing and its requests; only the setting toasts.
 */
export interface PrintRefresh {
  /** The plugin's context, for toasts and their Open; null once it is disposed. */
  attach(ctx: PrintWatchContext | null): void;
  setNotifying(on: boolean): void;
  /** An ECO pane can be seen; the returned release says it no longer can. */
  retainVisiblePane(): () => void;
}

export function createPrintRefresh(
  start: (ctx: PrintWatchContext) => () => void = startHighImpactPrintWatch,
): PrintRefresh {
  let host: PrintWatchContext | null = null;
  let notifying = false;
  let visiblePanes = 0;
  let stopWatch: (() => void) | null = null;
  // A print that lands while only a pane wants the watch is recorded, not toasted.
  const watchContext: PrintWatchContext = {
    notify: (notice) => {
      if (notifying) host?.notify(notice);
    },
    showPane: (paneId) => host?.showPane(paneId),
  };
  const sync = () => {
    const wanted = notifying || visiblePanes > 0;
    if (wanted && !stopWatch) stopWatch = start(watchContext);
    if (!wanted && stopWatch) {
      stopWatch();
      stopWatch = null;
    }
  };
  return {
    attach(ctx) {
      host = ctx;
    },
    setNotifying(on) {
      notifying = on;
      sync();
    },
    retainVisiblePane() {
      visiblePanes += 1;
      sync();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        visiblePanes -= 1;
        sync();
      };
    },
  };
}

const printRefresh = createPrintRefresh();

/** For the ECO pane: while it can be seen, a due high-impact print is asked for on the watch's timing. */
export function retainVisiblePrintRefresh(): () => void {
  return printRefresh.retainVisiblePane();
}

/** Toasts prints while the Notifications setting is on; off, only a pane in view keeps the watch asking. */
export function setupHighImpactPrintNotifications(
  ctx: PrintNotificationContext,
  refresh: PrintRefresh = printRefresh,
): () => void {
  refresh.attach(ctx);
  const sync = () => refresh.setNotifying(printNotificationsEnabled(ctx));
  const disposeConfigListener = ctx.on("config:changed", sync);
  sync();
  return () => {
    disposeConfigListener();
    refresh.setNotifying(false);
    refresh.attach(null);
  };
}
