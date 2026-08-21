export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage wrapper that keeps the app usable when JSON or quota is bad. */
export class SafeJsonStorage<T> {
  private value: T;

  constructor(
    private readonly storage: StorageLike,
    readonly key: string,
    fallback: T,
    validate: (value: unknown) => value is T = (_value): _value is T => true,
  ) {
    this.value = fallback;
    try {
      const raw = storage.getItem(key);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (!validate(parsed)) throw new Error("Invalid stored value");
        this.value = parsed;
      }
    } catch {
      try { storage.removeItem(key); } catch {}
    }
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    try { this.storage.setItem(this.key, JSON.stringify(value)); } catch {}
  }

  clear(fallback: T): void {
    this.value = fallback;
    try { this.storage.removeItem(this.key); } catch {}
  }
}

export const BROWSER_STORAGE_KEYS = {
  config: "gloomberb.web.config.v1",
  tickers: "gloomberb.web.tickers.v1",
  pluginState: "gloomberb.web.plugin-state.v1",
  session: "gloomberb.web.session.v1",
} as const;
