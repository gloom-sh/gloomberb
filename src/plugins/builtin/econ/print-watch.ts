import type { GloomPluginContext } from "../../../types/plugin";
import {
  getCalendarCache,
  hasPendingHighImpactPrint,
  landedHighImpactPrints,
  loadCalendar,
  PRINT_IDLE_MS,
  PRINT_POLL_MS,
} from "./calendar-model";
import type { EconEvent } from "./types";

const TOAST_DURATION_MS = 20_000;

function actuals(events: readonly EconEvent[]): Map<string, string | null> {
  return new Map(events.map((event) => [event.id, event.actual]));
}

function printBody(event: EconEvent): string {
  return event.forecast ? `${event.event} ${event.actual} vs ${event.forecast}` : `${event.event} ${event.actual}`;
}

export function startHighImpactPrintWatch(
  ctx: Pick<GloomPluginContext, "notify" | "showPane">,
  now: () => number = Date.now,
  loader: typeof loadCalendar = loadCalendar,
  schedule: (run: () => void, delay: number) => () => void = (run, delay) => {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  },
): () => void {
  let stopped = false;
  let cancel: (() => void) | null = null;
  let running = false;
  let seen: Map<string, string | null> | null = null;

  const arm = (delay: number) => {
    if (stopped || cancel) return;
    cancel = schedule(() => {
      cancel = null;
      void run();
    }, delay);
  };

  const run = async () => {
    if (stopped || running) return;
    const cached = getCalendarCache({ allowExpired: true });
    const pending = !seen || (cached ? hasPendingHighImpactPrint(cached.data, now()) : true);
    if (!pending) {
      arm(PRINT_IDLE_MS);
      return;
    }
    running = true;
    try {
      const result = await loader(pending);
      if (stopped) return;
      const previous = seen;
      seen = actuals(result.data);
      arm(hasPendingHighImpactPrint(result.data, now()) ? PRINT_POLL_MS : PRINT_IDLE_MS);
      if (previous) {
        for (const event of landedHighImpactPrints(previous, result.data)) {
          ctx.notify({
            title: event.country,
            body: printBody(event),
            type: "info",
            desktop: "always",
            sound: "Glass",
            duration: TOAST_DURATION_MS,
            action: { label: "Open", onClick: () => ctx.showPane("econ-calendar") },
          });
        }
      }
    } catch {
      if (!stopped) arm(PRINT_POLL_MS);
    } finally {
      running = false;
    }
  };

  void run();
  return () => {
    stopped = true;
    cancel?.();
    cancel = null;
  };
}
