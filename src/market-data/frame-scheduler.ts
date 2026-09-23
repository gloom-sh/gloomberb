import { debugLog } from "../utils/debug-log";

/**
 * One clock for streamed market data. Stream ticks, store writes and listener
 * notifications all land on the same frame, so a burst of quotes costs one
 * React commit and one paint instead of one per tick. Renderers install the
 * driver that matches how they paint: GUI builds align to animation frames,
 * the terminal to a fixed interval. Without an installed driver (tests, CLI,
 * the desktop backend process) frames coalesce per macrotask.
 */

/** GUI builds apply data at most this often, aligned to animation frames (~15 Hz). */
export const GUI_DATA_FRAME_MIN_INTERVAL_MS = 66;
/** OpenTUI redraws are expensive; at most 10 Hz keeps visible quotes lively without a render storm. */
export const TERMINAL_DATA_FRAME_INTERVAL_MS = 100;
/** A hidden document pauses animation frames; data still drains this often. */
const HIDDEN_DOCUMENT_FRAME_FALLBACK_MS = 1_000;
/**
 * With load pacing, the work one frame sets off (applying, React commits,
 * paint) may take at most 1/FRAME_LOAD_FACTOR of the time: a pane that needs
 * 60 ms per update gets one every 240 ms instead of stalling input.
 */
const FRAME_LOAD_FACTOR = 4;
/** Load pacing never slows visible data below the off-screen rate. */
const MAX_PACED_FRAME_INTERVAL_MS = 1_000;
/** Longer than this is a stall or a throttled timer, not the cost of a frame. */
const FRAME_COST_OUTLIER_MS = 500;
/** Share of a new cost sample in the running estimate, so one slow frame (a GC pause) barely moves it. */
const FRAME_COST_SMOOTHING = 0.3;
/** Tasks that queue more appliers are re-run inside one frame at most this many times. */
const MAX_APPLY_PASSES = 4;

const frameLog = debugLog.createLogger("market-data-frame");

export type DataFramePhase = "apply" | "notify";
export type DataFrameTask = () => void;

export interface DataFrameDriver {
  /** Minimum spacing between two frames. */
  readonly minIntervalMs: number;
  /** Monotonic clock the scheduler paces frames with. */
  now(): number;
  /** Runs `run` once, no sooner than `delayMs`, at the renderer's next frame opportunity. Returns a cancel. */
  schedule(run: () => void, delayMs: number): () => void;
  /**
   * Calls `probe` once the work a frame set off has had its turn: the React
   * commits its notifications queued and, on DOM, the layout and paint after
   * them. A driver with it spaces frames by what they cost (see withLoadPacing).
   */
  afterFrame?(probe: () => void): void;
}

export interface DataFrameRequest {
  phase?: DataFramePhase;
  /** Driver time before which the task must not run; background keys use it to wait out their interval. */
  notBefore?: number;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function createTimerFrameDriver(minIntervalMs: number): DataFrameDriver {
  return {
    minIntervalMs,
    now: monotonicNow,
    schedule(run, delayMs) {
      const timer = setTimeout(run, Math.max(0, delayMs));
      return () => clearTimeout(timer);
    },
  };
}

/**
 * Paint-aligned frames for DOM renderers. requestAnimationFrame stops while
 * the document is hidden; the fallback timer keeps non-visual consumers (price
 * alerts, totals) moving at about 1 Hz until it shows again.
 */
export function createAnimationFrameDriver(
  minIntervalMs = GUI_DATA_FRAME_MIN_INTERVAL_MS,
  hiddenFallbackMs = HIDDEN_DOCUMENT_FRAME_FALLBACK_MS,
): DataFrameDriver {
  const raf = globalThis.requestAnimationFrame?.bind(globalThis);
  const cancelRaf = globalThis.cancelAnimationFrame?.bind(globalThis);
  if (!raf || !cancelRaf) return createTimerFrameDriver(minIntervalMs);
  return {
    minIntervalMs,
    now: monotonicNow,
    schedule(run, delayMs) {
      let done = false;
      let frameId: number | null = null;
      let delayTimer: ReturnType<typeof setTimeout> | null = null;
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (frameId !== null) cancelRaf(frameId);
        if (delayTimer !== null) clearTimeout(delayTimer);
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        frameId = null;
        delayTimer = null;
        fallbackTimer = null;
      };
      const fire = () => {
        if (done) return;
        done = true;
        cleanup();
        run();
      };
      const requestPaintFrame = () => {
        delayTimer = null;
        frameId = raf(fire);
        fallbackTimer = setTimeout(fire, hiddenFallbackMs);
      };
      if (delayMs > 1) delayTimer = setTimeout(requestPaintFrame, delayMs);
      else requestPaintFrame();
      return () => {
        done = true;
        cleanup();
      };
    },
  };
}

/**
 * Lets the scheduler space a driver's frames by their measured cost. The
 * probe runs on the next macrotask, after the microtasks where React commits
 * store updates and, in a browser, after the paint that follows an animation
 * frame.
 */
export function withLoadPacing(driver: DataFrameDriver): DataFrameDriver {
  return {
    ...driver,
    afterFrame(probe) {
      setTimeout(probe, 0);
    },
  };
}

/**
 * Deterministic driver for tests: time only moves when the test advances it,
 * or spends it inside a frame to stand for that frame's cost.
 */
export function createManualFrameDriver(minIntervalMs: number): {
  driver: DataFrameDriver;
  advance(ms: number): void;
  spend(ms: number): void;
  readonly pending: boolean;
} {
  let now = 0;
  let scheduled: { run: () => void; at: number } | null = null;
  const probes: Array<() => void> = [];
  return {
    driver: {
      minIntervalMs,
      now: () => now,
      schedule(run, delayMs) {
        const entry = { run, at: now + Math.max(0, delayMs) };
        scheduled = entry;
        return () => {
          if (scheduled === entry) scheduled = null;
        };
      },
      afterFrame(probe) {
        probes.push(probe);
      },
    },
    advance(ms) {
      const target = now + ms;
      while (scheduled && scheduled.at <= target) {
        const entry: { run: () => void; at: number } = scheduled;
        scheduled = null;
        now = Math.max(now, entry.at);
        entry.run();
        for (const probe of probes.splice(0)) probe();
      }
      now = Math.max(now, target);
    },
    spend(ms) {
      now += ms;
    },
    get pending() {
      return scheduled !== null;
    },
  };
}

export class DataFrameScheduler {
  private readonly queues: Record<DataFramePhase, Map<DataFrameTask, number>> = {
    apply: new Map(),
    notify: new Map(),
  };
  private cancelScheduled: (() => void) | null = null;
  private scheduledAt: number | null = null;
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  private running = false;
  /** Running estimate of what one notifying frame costs, when the driver reports it. */
  private frameCostMs = 0;

  constructor(private driver: DataFrameDriver = createTimerFrameDriver(0)) {}

  setDriver(driver: DataFrameDriver): void {
    this.cancel();
    this.driver = driver;
    this.lastFrameAt = Number.NEGATIVE_INFINITY;
    this.frameCostMs = 0;
    this.reschedule();
  }

  /** Current spacing between frames: the driver's minimum, stretched while frames are expensive. */
  frameIntervalMs(): number {
    return Math.max(
      this.driver.minIntervalMs,
      Math.min(MAX_PACED_FRAME_INTERVAL_MS, this.frameCostMs * FRAME_LOAD_FACTOR),
    );
  }

  private recordFrameCost(costMs: number): void {
    if (!Number.isFinite(costMs) || costMs < 0 || costMs > FRAME_COST_OUTLIER_MS) return;
    this.frameCostMs += (costMs - this.frameCostMs) * FRAME_COST_SMOOTHING;
    // The next frame was booked before this cost was known.
    if (!this.running && this.scheduledAt !== null && this.scheduledAt < this.lastFrameAt + this.frameIntervalMs()) {
      this.cancel();
      this.reschedule();
    }
  }

  now(): number {
    return this.driver.now();
  }

  /** Queues a task for the next frame. A task queued twice runs once. */
  request(task: DataFrameTask, { phase = "apply", notBefore = Number.NEGATIVE_INFINITY }: DataFrameRequest = {}): void {
    const queue = this.queues[phase];
    const existing = queue.get(task);
    queue.set(task, existing === undefined ? notBefore : Math.min(existing, notBefore));
    if (!this.running) this.reschedule();
  }

  remove(task: DataFrameTask): void {
    this.queues.apply.delete(task);
    this.queues.notify.delete(task);
    if (!this.running) this.reschedule();
  }

  private cancel(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.scheduledAt = null;
  }

  private reschedule(): void {
    let earliest = Number.POSITIVE_INFINITY;
    for (const queue of Object.values(this.queues)) {
      for (const notBefore of queue.values()) earliest = Math.min(earliest, notBefore);
    }
    if (earliest === Number.POSITIVE_INFINITY) {
      this.cancel();
      return;
    }
    const at = Math.max(this.lastFrameAt + this.frameIntervalMs(), earliest);
    if (this.scheduledAt !== null && this.scheduledAt <= at) return;
    this.cancel();
    this.scheduledAt = at;
    this.cancelScheduled = this.driver.schedule(() => {
      this.cancelScheduled = null;
      this.scheduledAt = null;
      this.runFrame();
    }, at - this.driver.now());
  }

  private takeDue(phase: DataFramePhase, now: number): DataFrameTask[] {
    const due: DataFrameTask[] = [];
    for (const [task, notBefore] of this.queues[phase]) {
      if (notBefore <= now) due.push(task);
    }
    for (const task of due) this.queues[phase].delete(task);
    return due;
  }

  private runFrame(): void {
    if (this.running) return;
    this.running = true;
    const driver = this.driver;
    const now = driver.now();
    this.lastFrameAt = now;
    let notified = false;
    try {
      // Applying a batch may queue another applier (a flush feeding a
      // derived store); those still belong to this frame.
      for (let pass = 0; pass < MAX_APPLY_PASSES; pass += 1) {
        const due = this.takeDue("apply", now);
        if (due.length === 0) break;
        runTasks(due);
      }
      // Listeners that write data while being notified are heard next frame.
      const listeners = this.takeDue("notify", now);
      notified = listeners.length > 0;
      runTasks(listeners);
    } finally {
      this.running = false;
      // Only a frame that told readers something sets off renders worth timing.
      if (notified && driver.afterFrame) {
        driver.afterFrame(() => {
          if (this.driver === driver) this.recordFrameCost(driver.now() - now);
        });
      }
      this.reschedule();
    }
  }
}

function runTasks(tasks: DataFrameTask[]): void {
  for (const task of tasks) {
    try {
      task();
    } catch (error) {
      // One failing listener must not starve the rest of the frame; the error
      // still surfaces as uncaught, as it did when each ran in its own task.
      frameLog.error("market data frame task failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

/** The app-wide scheduler every coordinator uses unless a test injects its own. */
export const marketDataFrames = new DataFrameScheduler();

export function installMarketDataFrameDriver(driver: DataFrameDriver): void {
  marketDataFrames.setDriver(driver);
}
