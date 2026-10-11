import {
  TICKER_PLACEHOLDER,
  hostLabelWords,
  splitSeriesId,
  validateSeriesDefinition,
} from "./validate";
import type {
  RegisteredSeries,
  SeriesCatalogEntry,
  SeriesDefinition,
} from "./types";

/** The expression a loaded series charts as: the namespace is its chart-series capability. */
function loadedSeriesExpression(definition: Pick<SeriesDefinition, "id" | "input">): string {
  return `CAP:${definition.id}${definition.input ? `/${TICKER_PLACEHOLDER}` : ""}`;
}

export function seriesExpression(definition: SeriesDefinition): string {
  return definition.expression ?? loadedSeriesExpression(definition);
}

/**
 * The capability series id a loaded series charts under: its name, and for a
 * series with an input, the symbol after a slash (`days-to-cover/AAPL`).
 */
export function capabilitySeriesId(definition: Pick<SeriesDefinition, "id">, ticker?: string): string {
  const name = splitSeriesId(definition.id)?.name ?? definition.id;
  return ticker ? `${name}/${encodeURIComponent(ticker.trim().toUpperCase())}` : name;
}

/** The registered id and the typed symbol a capability series id names. */
function parseCapabilitySeriesId(namespace: string, seriesId: string): { id: string; ticker?: string } {
  const slash = seriesId.indexOf("/");
  if (slash < 0) return { id: `${namespace}:${seriesId}` };
  let ticker: string;
  try {
    ticker = decodeURIComponent(seriesId.slice(slash + 1));
  } catch {
    ticker = seriesId.slice(slash + 1);
  }
  return { id: `${namespace}:${seriesId.slice(0, slash)}`, ticker };
}

export function seriesCatalogEntry(series: RegisteredSeries): SeriesCatalogEntry {
  const { definition, pluginId } = series;
  return {
    id: definition.id,
    name: definition.name,
    unit: definition.unit,
    frequency: definition.frequency,
    ...(definition.group ? { group: definition.group } : {}),
    ...(definition.tags?.length ? { tags: [...definition.tags] } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.publisher ? { publisher: definition.publisher } : {}),
    ...(definition.url ? { url: definition.url } : {}),
    ...(definition.input ? { input: definition.input } : {}),
    expression: seriesExpression(definition),
    pluginId,
  };
}

interface SeriesRegistryOptions {
  /** The hosts a plugin declares, whose names its labels may not carry. */
  pluginHosts?(pluginId: string): readonly string[] | undefined;
  /** Called when the first loaded series of a namespace arrives, and with null when its last one leaves. */
  onNamespaceChange?(namespace: string, pluginId: string | null): void;
}

/**
 * Every series registered in this process, keyed by id. The data catalog and
 * the chart composer's series search read it; a loaded series resolves
 * through it. Ids are unique, and a namespace with loaded series belongs to
 * the plugin that registered the first of them.
 */
export class SeriesRegistry {
  private readonly entries = new Map<string, RegisteredSeries>();
  private readonly namespaces = new Map<string, { pluginId: string; loaded: number }>();
  private readonly listeners = new Set<() => void>();
  private readonly refreshers = new Set<() => Promise<void> | void>();
  private snapshot: readonly RegisteredSeries[] | null = null;
  private expressions: Map<string, RegisteredSeries> | null = null;
  private catalogSnapshot: readonly SeriesCatalogEntry[] | null = null;
  private version = 0;

  constructor(private readonly options: SeriesRegistryOptions = {}) {}

  /** Adds one series; throws when it is invalid or its id or namespace is taken. */
  register(pluginId: string, definition: SeriesDefinition): () => void {
    validateSeriesDefinition(definition, {
      forbiddenWords: hostLabelWords(this.options.pluginHosts?.(pluginId)),
    });
    const existing = this.entries.get(definition.id);
    if (existing) {
      throw new Error(`Series "${definition.id}" is already registered by plugin "${existing.pluginId}".`);
    }
    const { namespace } = splitSeriesId(definition.id)!;
    const owner = this.namespaces.get(namespace);
    if (definition.load && owner && owner.pluginId !== pluginId) {
      throw new Error(`Series namespace "${namespace}" belongs to plugin "${owner.pluginId}".`);
    }
    const registration: RegisteredSeries = { definition, pluginId };
    this.entries.set(definition.id, registration);
    if (definition.load) {
      if (owner) owner.loaded += 1;
      else {
        this.namespaces.set(namespace, { pluginId, loaded: 1 });
        this.options.onNamespaceChange?.(namespace, pluginId);
      }
    }
    this.changed();
    return () => {
      if (this.entries.get(definition.id) !== registration) return;
      this.entries.delete(definition.id);
      if (definition.load) {
        const current = this.namespaces.get(namespace);
        if (current && --current.loaded <= 0) {
          this.namespaces.delete(namespace);
          this.options.onNamespaceChange?.(namespace, null);
        }
      }
      this.changed();
    };
  }

  get(id: string): RegisteredSeries | undefined {
    return this.entries.get(id);
  }

  /** The plugin whose loaded series a namespace holds. */
  namespaceOwner(namespace: string): string | undefined {
    return this.namespaces.get(namespace)?.pluginId;
  }

  /** The loaded series a chart-series capability source names, with the typed symbol. */
  findLoaded(capabilityId: string, seriesId: string): { series: RegisteredSeries; ticker?: string } | null {
    if (!this.namespaces.has(capabilityId)) return null;
    const { id, ticker } = parseCapabilitySeriesId(capabilityId, seriesId);
    const series = this.entries.get(id);
    if (!series?.definition.load) return null;
    if (!!series.definition.input !== !!ticker) return null;
    return { series, ...(ticker ? { ticker } : {}) };
  }

  /** The series that charts as this exact expression (`FRED:UNRATE`), if one without an input does. */
  findByExpression(expression: string): RegisteredSeries | undefined {
    if (!this.expressions) {
      this.expressions = new Map();
      for (const series of this.entries.values()) {
        if (series.definition.input) continue;
        const key = seriesExpression(series.definition);
        if (!this.expressions.has(key)) this.expressions.set(key, series);
      }
    }
    return this.expressions.get(expression);
  }

  /** In registration order. The array is shared until the next change. */
  list(): readonly RegisteredSeries[] {
    this.snapshot ??= [...this.entries.values()];
    return this.snapshot;
  }

  catalog(): readonly SeriesCatalogEntry[] {
    this.catalogSnapshot ??= this.list().map(seriesCatalogEntry);
    return this.catalogSnapshot;
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * For a source whose series can change while the app runs, such as files in
   * a folder: called before the catalog is shown, so it can register what is
   * new and drop what went away.
   */
  addRefresher(refresh: () => Promise<void> | void): () => void {
    this.refreshers.add(refresh);
    return () => { this.refreshers.delete(refresh); };
  }

  async refresh(): Promise<void> {
    await Promise.allSettled([...this.refreshers].map((refresh) => refresh()));
  }

  private changed(): void {
    this.snapshot = null;
    this.catalogSnapshot = null;
    this.expressions = null;
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}
