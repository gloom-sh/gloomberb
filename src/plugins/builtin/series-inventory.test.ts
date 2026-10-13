import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLoadablePlugins } from "../catalog";
import { SeriesRegistry, seriesExpression } from "../../series/registry";
import { parseSeriesExpression } from "./chart-composer/series-expression";
import { SERIES_INVENTORY } from "./series-inventory";

const BUILTIN_DIR = import.meta.dir;
/** What drawing a chart looks like in a module's source. */
const CHART_USE = /\b(?:CompositeChart|StaticChartSurface|CurveSurface|ScatterChartSurface|TrailChartSurface|PriceSparkline|MetricTreemapSurface|SeriesDetailChart|Surface3DChart)\b|\bstaticSeries\(/;
/** Folders that hold shared code rather than a module. */
const NOT_MODULES = new Set(["shared"]);
/** The public bodies built-in series may name as their publisher. */
// Ember publishes open energy data under CC-BY-4.0, whose attribution the day-ahead series carry; EEX is
// the EU ETS common auction platform, which publishes the auction results; the BIS publishes the central
// bank policy rates the policy-rate series chart outside the US and the euro area; GIE AGSI+ is the
// storage operators' transparency platform, which asks to be named as the source of its data.
const PUBLISHERS = new Set(["FRED", "BIS", "EIA", "CFTC", "FINRA", "Bundesbank", "Bank of England", "Japan Ministry of Finance", "Bank of Canada", "ECB", "U.S. Treasury", "SEC", "Ember", "EEX", "GIE AGSI+"]);
const SAMPLE_INPUTS = { ticker: "AAPL", option: "AAPL260618C00200000", crypto: "BTC-USD" } as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function chartModules(): string[] {
  return readdirSync(BUILTIN_DIR).filter((name) => {
    const path = join(BUILTIN_DIR, name);
    return !NOT_MODULES.has(name) && statSync(path).isDirectory()
      && sourceFiles(path).some((file) => CHART_USE.test(readFileSync(file, "utf8")));
  });
}

function matches(pattern: string, id: string): boolean {
  return pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern;
}

function registerBuiltins() {
  const plugins = getLoadablePlugins();
  const registry = new SeriesRegistry({ pluginHosts: (id) => plugins.find((plugin) => plugin.id === id)?.hosts });
  const errors: string[] = [];
  for (const plugin of plugins) {
    for (const definition of plugin.series ?? []) {
      try {
        registry.register(plugin.id, definition);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { registry, errors };
}

describe("built-in series inventory", () => {
  test("every module that draws a chart is audited, and every audited module exists", () => {
    const audited = new Set(SERIES_INVENTORY.map((entry) => entry.module));
    expect(chartModules().filter((module) => !audited.has(module))).toEqual([]);
    expect([...audited].filter((module) => !statSync(join(BUILTIN_DIR, module), { throwIfNoEntry: false })?.isDirectory()))
      .toEqual([]);
  });

  test("the audit and the registered series name each other", () => {
    const { registry, errors } = registerBuiltins();
    expect(errors).toEqual([]);
    const ids = registry.list().map((series) => series.definition.id);
    const patterns = SERIES_INVENTORY.flatMap((entry) => "series" in entry ? entry.series : []);
    const staticPatterns = SERIES_INVENTORY.flatMap((entry) => "series" in entry && !entry.runtime ? entry.series : []);
    expect(staticPatterns.filter((pattern) => !ids.some((id) => matches(pattern, id)))).toEqual([]);
    expect(ids.filter((id) => !patterns.some((pattern) => matches(pattern, id)))).toEqual([]);
  });

  test("every built-in series charts: its expression parses, once per input, and its publisher is a public body", () => {
    const { registry } = registerBuiltins();
    const seen = new Map<string, string>();
    const problems: string[] = [];
    for (const { definition } of registry.list()) {
      const template = seriesExpression(definition);
      const key = `${definition.input ?? ""}|${template}`;
      if (seen.has(key)) problems.push(`${definition.id} charts the same as ${seen.get(key)}`);
      seen.set(key, definition.id);
      const sample = definition.input ? template.replaceAll("{ticker}", SAMPLE_INPUTS[definition.input]) : template;
      if (!parseSeriesExpression(sample)) problems.push(`${definition.id}: ${sample} does not parse`);
      if (definition.publisher && !PUBLISHERS.has(definition.publisher)) problems.push(`${definition.id}: publisher ${definition.publisher}`);
      if (!definition.group) problems.push(`${definition.id} has no group`);
    }
    expect(problems).toEqual([]);
  });
});
