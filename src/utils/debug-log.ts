
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  source: string;
  message: string;
  data?: unknown;
}

type LogListener = (entry: LogEntry) => void;
type ConsoleMethod = (...args: unknown[]) => void;

interface ConsoleMirror {
  sources: Set<string> | null;
  minLevel: LogLevel;
  methods: {
    log: ConsoleMethod;
    info: ConsoleMethod;
    warn: ConsoleMethod;
    error: ConsoleMethod;
  };
}

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class DebugLog {
  private entries: LogEntry[] = [];
  private listeners = new Set<LogListener>();
  private nextId = 1;
  private maxEntries = 5000;
  private consoleMirror: ConsoleMirror | null = null;
  private mirroringToConsole = false;

  /** Create a logger scoped to a source (plugin id, module name, etc.) */
  createLogger(source: string) {
    return {
      debug: (message: string, data?: unknown) => this.add("debug", source, message, data),
      info: (message: string, data?: unknown) => this.add("info", source, message, data),
      warn: (message: string, data?: unknown) => this.add("warn", source, message, data),
      error: (message: string, data?: unknown) => this.add("error", source, message, data),
    };
  }

  private add(level: LogLevel, source: string, message: string, data?: unknown) {
    const entry: LogEntry = {
      id: this.nextId++,
      timestamp: Date.now(),
      level,
      source,
      message,
      data,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-Math.floor(this.maxEntries * 0.8));
    }
    this.mirrorEntryToConsole(entry);
    for (const listener of this.listeners) {
      try { listener(entry); } catch { /* Intentional ignore: A broken log listener must not block other listeners or recursively log itself. */ }
    }
  }

  /** Mirror selected debug-log sources to the real console for DevTools diagnostics. */
  mirrorToConsole(options: { sources?: readonly string[]; minLevel?: LogLevel } = {}): () => void {
    const mirror: ConsoleMirror = {
      sources: options.sources ? new Set(options.sources) : null,
      minLevel: options.minLevel ?? "debug",
      methods: {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
      },
    };
    this.consoleMirror = mirror;
    return () => {
      if (this.consoleMirror === mirror) this.consoleMirror = null;
    };
  }

  private mirrorEntryToConsole(entry: LogEntry) {
    const mirror = this.consoleMirror;
    if (this.mirroringToConsole) return;
    if (!mirror) return;
    if (mirror.sources && !mirror.sources.has(entry.source)) return;
    if (LOG_LEVEL_RANK[entry.level] < LOG_LEVEL_RANK[mirror.minLevel]) return;

    const ts = new Date(entry.timestamp).toISOString().slice(11, 23);
    const prefix = `[gloom:${entry.source}] ${ts} ${entry.message}`;
    const method =
      entry.level === "error" ? mirror.methods.error
      : entry.level === "warn" ? mirror.methods.warn
      : entry.level === "info" ? mirror.methods.info
      : mirror.methods.log;

    try {
      this.mirroringToConsole = true;
      if (entry.data === undefined) {
        method(prefix);
      } else {
        method(prefix, entry.data);
      }
    } finally {
      this.mirroringToConsole = false;
    }
  }

  /** Subscribe to new log entries. Returns unsubscribe function. */
  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Get all entries, optionally filtered */
  getEntries(filter?: { level?: LogLevel; source?: string }): LogEntry[] {
    if (!filter) return this.entries;
    return this.entries.filter((e) => {
      if (filter.level && e.level !== filter.level) return false;
      if (filter.source && e.source !== filter.source) return false;
      return true;
    });
  }

  /** Get unique source names seen so far */
  getSources(): string[] {
    const sources = new Set<string>();
    for (const entry of this.entries) sources.add(entry.source);
    return [...sources].sort();
  }

  /** Clear all entries */
  clear() {
    this.entries = [];
    this.nextId = 1;
  }

  /** Export entries as a formatted text string */
  exportAsText(filter?: { level?: LogLevel; source?: string }): string {
    const entries = this.getEntries(filter);
    const lines: string[] = [
      `Gloom Debug Log — exported ${new Date().toISOString()}`,
      `Total entries: ${entries.length}`,
      "=".repeat(80),
      "",
    ];
    for (const e of entries) {
      const ts = new Date(e.timestamp).toISOString().slice(11, 23);
      const lvl = e.level.toUpperCase().padEnd(5);
      let dataStr = "";
      if (e.data !== undefined) {
        const serialized = JSON.stringify(e.data);
        if (serialized.length <= 500) dataStr = `  ${serialized}`;
      }
      lines.push(`[${ts}] ${lvl} [${e.source}] ${e.message}${dataStr}`);
    }
    return lines.join("\n");
  }

  /** Intercept console methods and route them through the debug log */
  interceptConsole() {
    const orig = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
    };

    const format = (args: unknown[]): string =>
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

    console.log = (...args: unknown[]) => {
      this.add("debug", "console", format(args));
      orig.log(...args);
    };
    console.info = (...args: unknown[]) => {
      this.add("info", "console", format(args));
      orig.info(...args);
    };
    console.warn = (...args: unknown[]) => {
      this.add("warn", "console", format(args));
      orig.warn(...args);
    };
    console.error = (...args: unknown[]) => {
      this.add("error", "console", format(args));
      orig.error(...args);
    };
  }
}

/** Singleton debug log instance */
export const debugLog = new DebugLog();

export type PluginLogger = ReturnType<DebugLog["createLogger"]>;
