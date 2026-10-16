import { isAppVisible, subscribeAppVisibility } from "../../../state/app/activity";
import { cloudSyncController } from "../../../sync/controller";
import type { GloomPluginContext } from "../../../types/plugin";
import { zonedDateKey } from "../../../utils/zoned-date-time";
import {
  acceptDailyBriefWake,
  armDailyBriefWake,
  BRIEF_WAKE_GAP_MS,
  briefWakeDecision,
  briefWakeTimeZone,
  DAILY_BRIEF_PLUGIN_ID,
  DAILY_BRIEF_TEMPLATE_ID,
  dailyBriefWakePending,
  initialSyncSettled,
  launchedWithCommand,
  OPEN_ON_WAKE_SETTING,
  OPENED_ON_KEY,
  openOnWakeEnabled,
  wakeSyncSettled,
  type BriefSyncPhase,
} from "./wake";

const TICK_MS = 15_000;
const STARTUP_ATTEMPT_MS = 10_000;
const WAKE_ATTEMPT_MS = 2_000;
const LATE_SYNC_MS = 8_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function launchArgv(): readonly string[] {
  const argv = (globalThis as { process?: { argv?: readonly string[] } }).process?.argv;
  return argv ? argv.slice(2) : [];
}

function syncPhase(): BriefSyncPhase {
  return cloudSyncController.getStatus().phase;
}

async function waitForSync(kind: "startup" | "wake", disposed: () => boolean): Promise<void> {
  const started = Date.now();
  let sawSyncing = false;
  const settled = kind === "startup" ? initialSyncSettled : wakeSyncSettled;
  while (!disposed()) {
    const phase = syncPhase();
    if (phase === "syncing") sawSyncing = true;
    if (settled({ phase, elapsedMs: Date.now() - started, sawSyncing })) return;
    await delay(100);
  }
}

async function waitUntil(ms: number, ready: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ready()) return true;
    await delay(20);
  }
  return ready();
}

export function startDailyBriefWake(ctx: GloomPluginContext): () => void {
  const timeZone = briefWakeTimeZone();
  const argv = launchArgv();
  let disposed = false;
  let lastTick = Date.now();
  let opening: Promise<void> | null = null;
  const isDisposed = () => disposed;

  const openedOn = (): string | null => {
    try {
      const value = ctx.resume.getState<string>(OPENED_ON_KEY);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  };

  const canOpen = (): boolean => {
    try {
      const config = ctx.getConfig();
      if (!config.onboardingComplete) return false;
      if (config.disabledPlugins.includes(DAILY_BRIEF_PLUGIN_ID)) return false;
      return openOnWakeEnabled(ctx.configState.get(OPEN_ON_WAKE_SETTING));
    } catch {
      return false;
    }
  };

  const openBrief = (budgetMs: number, force: boolean): Promise<void> => {
    if (opening) return opening;
    opening = (async () => {
      const deadline = Date.now() + budgetMs;
      while (!disposed && Date.now() < deadline) {
        if (!canOpen()) return;
        const day = zonedDateKey(Date.now(), timeZone);
        if (!force && openedOn() === day) return;
        const token = `${day}:${Date.now()}:${force ? "f" : "o"}`;
        armDailyBriefWake(token);
        try {
          ctx.createPaneFromTemplate(DAILY_BRIEF_TEMPLATE_ID, { values: { wake: token } });
        } catch {
          acceptDailyBriefWake(token);
          return;
        }
        const accepted = await waitUntil(300, () => !dailyBriefWakePending(token));
        acceptDailyBriefWake(token);
        if (!accepted) {
          await delay(200);
          continue;
        }
        try { ctx.resume.setState(OPENED_ON_KEY, day); } catch { /* The pane is already in front. */ }
        return;
      }
    })().finally(() => { opening = null; });
    return opening;
  };

  const consider = (kind: "startup" | "tick", now: number, previousTick: number | null, budgetMs: number) => {
    const decision = briefWakeDecision({
      enabled: canOpen(),
      openedOn: openedOn(),
      now,
      previousTick,
      timeZone,
      kind,
      launchedCommand: launchedWithCommand(argv),
    });
    if (!decision.open) return;
    void openBrief(budgetMs, false);
  };

  const boot = async () => {
    while (!disposed) {
      try {
        const config = ctx.getConfig();
        if (config.disabledPlugins.includes(DAILY_BRIEF_PLUGIN_ID)) return;
        if (!config.onboardingComplete) {
          await delay(200);
          continue;
        }
        if (!openOnWakeEnabled(ctx.configState.get(OPEN_ON_WAKE_SETTING))) return;
        break;
      } catch {
        await delay(200);
      }
    }
    if (disposed) return;
    await waitForSync("startup", isDisposed);
    if (disposed) return;
    consider("startup", Date.now(), null, STARTUP_ATTEMPT_MS);
    const late = Date.now();
    let sawSyncing = false;
    while (!disposed && Date.now() - late < LATE_SYNC_MS) {
      const phase = syncPhase();
      if (phase === "syncing") sawSyncing = true;
      if (sawSyncing && phase !== "syncing") {
        if (opening) await opening;
        if (!disposed && canOpen()) await openBrief(STARTUP_ATTEMPT_MS, true);
        return;
      }
      await delay(100);
    }
  };
  void boot();

  const onGap = (previousTick: number) => {
    const now = Date.now();
    const decision = briefWakeDecision({
      enabled: canOpen(),
      openedOn: openedOn(),
      now,
      previousTick,
      timeZone,
      kind: "tick",
      launchedCommand: false,
    });
    if (!decision.open) return;
    void (async () => {
      await waitForSync("wake", isDisposed);
      if (!disposed) consider("tick", Date.now(), previousTick, WAKE_ATTEMPT_MS);
    })();
  };

  const timer = setInterval(() => {
    const previous = lastTick;
    lastTick = Date.now();
    if (lastTick - previous < BRIEF_WAKE_GAP_MS) return;
    try { onGap(previous); } catch { /* A wake check must not take down the shell. */ }
  }, TICK_MS);
  (timer as { unref?: () => void }).unref?.();

  let hiddenAt: number | null = null;
  const stopVisibility = subscribeAppVisibility(() => {
    if (!isAppVisible()) {
      hiddenAt = Date.now();
      return;
    }
    const hidden = hiddenAt;
    hiddenAt = null;
    if (hidden == null) return;
    try { onGap(hidden); } catch { /* Same as the timer. */ }
  });

  return () => {
    disposed = true;
    clearInterval(timer);
    stopVisibility();
  };
}
