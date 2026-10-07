export function remoteEvent(input?: unknown) {
  return {
    input,
    preventDefault() {},
    stopPropagation() {},
  };
}

export function remoteStringValue(input: unknown): string;
export function remoteStringValue<T extends string | undefined>(input: unknown, fallback: T): string | T;
export function remoteStringValue(input: unknown, fallback?: string): string | undefined {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && typeof (input as { value?: unknown }).value === "string") {
    return (input as { value: string }).value;
  }
  return arguments.length >= 2 ? fallback : "";
}

export function remoteNumberValue(input: unknown, keys: string[], fallback = 0): number {
  if (typeof input === "number") return input;
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === "number") return record[key];
    }
  }
  return fallback;
}

function remoteOptionalNumberValue(input: unknown, keys: string[]): number | undefined {
  if (typeof input === "number") return input;
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === "number") return record[key];
    }
  }
  return undefined;
}

export function remoteChartEvent(input: unknown, renderable: unknown, width?: number, height?: number) {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const resolvedWidth = Math.max(1, width ?? remoteNumberProp(renderable, "width") ?? remoteNumberProp(remoteObjectProp(renderable, "absoluteBounds"), "width") ?? 1);
  const resolvedHeight = Math.max(1, height ?? remoteNumberProp(renderable, "height") ?? remoteNumberProp(remoteObjectProp(renderable, "absoluteBounds"), "height") ?? 1);
  const x = clampRemoteCoordinate(remoteOptionalNumberValue(input, ["x", "cellX", "column"]), resolvedWidth);
  const y = clampRemoteCoordinate(remoteOptionalNumberValue(input, ["y", "cellY", "row"]), resolvedHeight);
  const originX = remoteNumberProp(renderable, "absoluteX")
    ?? remoteNumberProp(remoteObjectProp(renderable, "absoluteBounds"), "x")
    ?? remoteNumberProp(renderable, "x")
    ?? 0;
  const originY = remoteNumberProp(renderable, "absoluteY")
    ?? remoteNumberProp(remoteObjectProp(renderable, "absoluteBounds"), "y")
    ?? remoteNumberProp(renderable, "y")
    ?? 0;
  return {
    input,
    x: originX + x,
    y: originY + y,
    preciseX: originX + x,
    preciseY: originY + y,
    pixelX: remoteOptionalNumberValue(input, ["pixelX"]),
    pixelY: remoteOptionalNumberValue(input, ["pixelY"]),
    button: typeof record.button === "number" ? record.button : 0,
    modifiers: {
      shift: record.shift === true,
      alt: record.alt === true,
      ctrl: record.ctrl === true,
    },
    scroll: remoteChartScroll(input),
    preventDefault() {},
    stopPropagation() {},
  };
}

export function remotePropLabel(props: Record<string, unknown>): string | undefined {
  for (const key of ["aria-label", "title", "label", "placeholder"]) {
    const value = props[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function remotePropRole(props: Record<string, unknown>, fallback: string): string {
  const explicit = props["data-gloom-role"];
  return typeof explicit === "string" && explicit.trim() ? explicit.trim() : fallback;
}

export function remoteMetadataFromProps(props: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const scope = props["data-gloom-remote-scope"];
  const surface = props["data-gloom-remote-surface"];
  const kind = props["data-gloom-remote-kind"];
  if (typeof scope === "string" && scope.trim()) metadata.scope = scope.trim();
  if (typeof surface === "string" && surface.trim()) metadata.surface = surface.trim();
  if (typeof kind === "string" && kind.trim()) metadata.kind = kind.trim();
  return metadata;
}

type RemoteItemSelector<T> = (item: T, index: number) => string | undefined;

interface RemoteIndexSelectors<T> {
  id?: RemoteItemSelector<T>;
  key?: RemoteItemSelector<T>;
  label?: RemoteItemSelector<T>;
  value?: RemoteItemSelector<T>;
}

export function resolveRemoteItemIndex<T>(
  input: unknown,
  items: readonly T[],
  selectors: RemoteIndexSelectors<T>,
): number {
  if (typeof input === "number") return input;
  if (typeof input === "string") return findRemoteItemIndex(input, items, Object.values(selectors));
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.index === "number") return record.index;
    for (const key of ["id", "key", "label", "value"] as const) {
      if (typeof record[key] !== "string") continue;
      const selector = selectors[key];
      if (!selector) continue;
      return findRemoteItemIndex(record[key], items, [selector]);
    }
  }
  return -1;
}

function remoteChartScroll(input: unknown) {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const direction = record.direction;
  if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") return undefined;
  return {
    direction,
    delta: typeof record.delta === "number" ? record.delta : 1,
  };
}

function remoteObjectProp(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function remoteNumberProp(value: unknown, key: string): number | undefined {
  const prop = remoteObjectProp(value, key);
  return typeof prop === "number" ? prop : undefined;
}

function clampRemoteCoordinate(value: number | undefined, extent: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Math.max(0, (extent - 1) / 2);
  return Math.max(0, Math.min(value, Math.max(extent - 1, 0)));
}

function findRemoteItemIndex<T>(
  value: string,
  items: readonly T[],
  selectors: Array<RemoteItemSelector<T> | undefined>,
): number {
  const activeSelectors = selectors.filter((selector): selector is RemoteItemSelector<T> => !!selector);
  if (activeSelectors.length === 0) return -1;
  return items.findIndex((item, index) => activeSelectors.some((selector) => selector(item, index) === value));
}
